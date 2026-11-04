const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const probe = fs.readFileSync(path.join(root, "scripts", "probe-panel.js"), "utf8");

test("probe scripts are syntactically valid", () => {
  assert.equal(spawnSync(process.execPath, ["--check", path.join(root, "scripts", "probe-panel.js")]).status, 0);
  if (process.platform !== "win32") {
    assert.equal(spawnSync("bash", ["-n", path.join(root, "scripts", "probe-windows.sh")]).status, 0);
  }
});

test("probe only reads: it never writes to the project, files or the DOM", () => {
  for (const forbidden of [/executeTransaction/, /lockedAccess/, /createBinAction/, /importFiles/, /writeFile/, /\.style\./, /classList\.(add|remove|toggle)/, /setAttribute/]) {
    assert.doesNotMatch(probe, forbidden);
  }
});

test("probe:windows is wired into package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["probe:windows"], "bash scripts/probe-windows.sh");
});

test("probe exits with a usage error when no plugin folder is given", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "probe-panel.js")], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});
