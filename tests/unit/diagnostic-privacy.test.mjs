import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const diagnosticSources = [
  "src/content/skill-source-dom.js",
  "src/content/skill-collector.js",
  "src/content/skill-workspace-controller.js"
];

test("skill diagnostics do not serialize business row previews or row HTML", async () => {
  for (const file of diagnosticSources) {
    const source = await fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /firstRawRowHTML|firstRowPreview/, `${file} must keep diagnostics structural-only`);
  }
});
