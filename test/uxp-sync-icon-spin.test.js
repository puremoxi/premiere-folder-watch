const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const js = fs.readFileSync(path.join(root, "main.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("sync icon artwork sits in a group the script can rotate", () => {
  assert.match(html, /<svg[^>]*><g id="syncSpin"><path [^>]*\/><\/g><\/svg>/);
});

test("sync icon is rotated by script while auto-sync is on or a sync runs because UXP ignores CSS animations", () => {
  const spinner = js.match(/function setSyncIconSpinning[\s\S]*?\n\}/);
  assert.ok(spinner, "setSyncIconSpinning is missing");
  assert.match(spinner[0], /setInterval/);
  assert.match(spinner[0], /setAttribute\("transform", `rotate\(/);
  assert.match(spinner[0], /clearInterval/);
  assert.match(spinner[0], /removeAttribute\("transform"\)/);
  assert.match(js, /setSyncIconSpinning\(runtime\.config\.autoSync \|\| runtime\.syncing\)/);
});
