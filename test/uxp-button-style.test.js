const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = fs.readFileSync(path.resolve(__dirname, "..", "style.css"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.#]/g, "\\$&");
  return [...css.matchAll(new RegExp(`^${escaped} \\{[\\s\\S]*?\\n\\}`, "gm"))].map((m) => m[0]).join("\n");
}

// Settings and Clear render as plain UXP buttons; the other buttons must match them.
for (const selector of [".primary", ".secondary", ".icon-button"]) {
  test(`${selector} has no outline or filled background`, () => {
    const block = rule(selector);
    assert.ok(block, `${selector} rule is missing`);
    assert.doesNotMatch(block, /border:\s*1px/);
    assert.doesNotMatch(block, /background: (?!transparent)/);
  });
}

test("card action buttons have no divider line", () => {
  assert.doesNotMatch(rule(".card-actions button"), /border-right:\s*1px/);
});

test("auto-sync control is a div painted with its own fill, gray-green when active", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<div id="toggleWatching" class="primary" role="button" tabindex="0">/);
  const base = css.match(/^#toggleWatching \{[^}]*\}/m)[0];
  const active = css.match(/^#toggleWatching\.watching \{[^}]*\}/m)[0];
  assert.match(base, /background-color:\s*#6a6a6a/);
  assert.match(active, /background-color:\s*#5e8a73/);
  assert.doesNotMatch(active, /border|outline|shadow/);
});
