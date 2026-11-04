#!/usr/bin/env node
// Read-only probe of the live Folder Watch panel through the UXP Developer Tool debug socket.
// Loads the plugin from a folder, attaches to its debug session and prints layout and style
// measurements. It never modifies the project, the panel DOM or any files.
//
// Usage (Windows Node 22+, because it uses the global WebSocket):
//   node scripts/probe-panel.js <plugin-folder> [--eval "<expression>"]
// Env: UDT_PORT (default 14001)
//
// UXP quirks the probe works around: element ids are not globals (the panel's `$()` helper is
// used), `innerWidth` is missing, and rectangles read 0 until about 800 ms after a DOM change.

const port = Number(process.env.UDT_PORT || 14001);
const args = process.argv.slice(2);
const evalIndex = args.indexOf("--eval");
const customExpression = evalIndex >= 0 ? args[evalIndex + 1] : null;
const pluginFolder = args.find((value, index) => !value.startsWith("--") && evalIndex < 0 || index !== evalIndex + 1);

if (!pluginFolder) {
  console.error("usage: node scripts/probe-panel.js <plugin-folder> [--eval \"<expression>\"]");
  process.exit(2);
}
if (typeof WebSocket === "undefined") {
  console.error("probe: this Node has no global WebSocket. Use Node 22 or newer.");
  process.exit(2);
}

// Layout summary evaluated inside the panel. Reads only.
const LAYOUT_EXPRESSION = `(() => {
  const rect = (element) => {
    if (!element) return "missing";
    const r = element.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(",");
  };
  const lines = [];
  lines.push("viewport=" + document.documentElement.clientWidth + "x" + document.documentElement.clientHeight);
  const byId = ["toggleWatching", "syncNow", "addFolder", "projectBanner", "summary", "activityLog", "settingsToggle"];
  for (const id of byId) {
    const element = $(id);
    const style = element ? getComputedStyle(element) : null;
    lines.push(id + " rect=" + rect(element) + (style ? " bg=" + style.backgroundColor + " border=" + style.borderTopWidth : ""));
  }
  for (const selector of [".brand-mark", ".project-icon", ".folder-glyph", ".watch-card h3", ".card-actions button"]) {
    lines.push(selector + " rect=" + rect(document.querySelector(selector)));
  }
  document.querySelectorAll(".summary span").forEach((label) => {
    lines.push("summary label " + label.textContent + " rect=" + rect(label));
  });
  return lines.join("\\n");
})()`;

const expression = customExpression || LAYOUT_EXPRESSION;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, code = 3) {
  console.error("probe: " + message);
  process.exit(code);
}

setTimeout(() => fail("timed out. Is the panel visible and UDT running?"), 40000);

const cli = new WebSocket(`ws://127.0.0.1:${port}/socket/cli`);
cli.onerror = () => fail(`cannot reach UDT on 127.0.0.1:${port}`);
let clientId = null;

cli.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.command === "didAddRuntimeClient" && String(message.app && message.app.appId).toLowerCase() === "premierepro") {
    clientId = message.id;
  }
  if (message.command === "didCompleteConnection") {
    if (!clientId) fail("Premiere is not connected to UDT.");
    cli.send(JSON.stringify({
      command: "proxy", clientId, requestId: 2,
      message: { command: "Plugin", action: "load", params: { provider: { type: "disk", path: pluginFolder } }, breakOnStart: false, isPlaygroundPlugin: false },
    }));
  }
  if (message.command === "reply" && message.requestId === 2) {
    if (!message.pluginSessionId) fail("UDT did not return a plugin session: " + JSON.stringify(message).slice(0, 300));
    cli.send(JSON.stringify({ command: "proxy", clientId, requestId: 3, message: { command: "Plugin", action: "debug", pluginSessionId: message.pluginSessionId } }));
  }
  if (message.command === "reply" && message.requestId === 3) {
    if (!message.wsdebugUrl) fail("UDT did not return a debug URL (is another debugger attached?).");
    attach(message.wsdebugUrl.replace(/^ws=/, "ws://"));
  }
};

function attach(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const contexts = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.executionContextCreated") {
      contexts.push(message.params.context);
    }
  };
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onopen = async () => {
    await call("Runtime.enable");
    await call("Runtime.runIfWaitingForDebugger");
    await wait(6000); // reload flicker, then the panel renders
    if (!contexts.length) fail("no execution context. Make the Folder Watch panel visible and retry.");
    await wait(1200); // rectangles read 0 shortly after DOM changes
    const result = await call("Runtime.evaluate", { expression, contextId: contexts[0].id, returnByValue: true });
    if (result.result && result.result.exceptionDetails) fail("evaluation failed: " + result.result.result.description);
    console.log(result.result.result.value);
    process.exit(0);
  };
}
