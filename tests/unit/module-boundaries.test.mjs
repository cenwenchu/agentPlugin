import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function imports(file) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  return [...source.matchAll(/from\s+["'](.+?)["']/g)].map((match) => match[1]);
}

test("table, context and overlay keep an acyclic static dependency boundary", () => {
  assert.equal(imports("src/content/table.js").includes("./overlay.js"), false);
  assert.equal(imports("src/content/context.js").includes("./table.js"), false);
  assert.equal(imports("src/content/context.js").includes("./overlay.js"), false);
});

test("skills facade uses extracted source and collector modules instead of table UI", () => {
  const skillImports = imports("src/content/skills.js");
  assert.equal(skillImports.includes("./table.js"), false);
  assert.equal(skillImports.includes("./skill-source-dom.js"), true);
  assert.equal(skillImports.includes("./skill-collector.js"), true);
});
