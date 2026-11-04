const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("bin children are read through FolderItem because plain ProjectItems have no getItems()", () => {
  const js = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const reader = js.match(/async function getChildren[\s\S]*?\n\}/);

  assert.ok(reader, "getChildren is missing");
  assert.match(reader[0], /asFolderItem\(item\)/);
  assert.match(reader[0], /folder\.getItems\(\)/);
});
