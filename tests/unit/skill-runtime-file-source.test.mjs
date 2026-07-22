import test from "node:test";
import assert from "node:assert/strict";
import {
  availableSkillRuntimeFileSlots,
  createSkillRuntimeFileSource,
  loadSkillRuntimeFileSources,
  resolveSkillRuntimeSheet
} from "../../src/content/skill-runtime-file-source.js";

test("resolves a runtime workbook sheet by one-based index or exact name", () => {
  const sheets = [{ name: "订单" }, { name: "售后" }];
  assert.equal(resolveSkillRuntimeSheet(sheets, "2"), sheets[1]);
  assert.equal(resolveSkillRuntimeSheet(sheets, "订单"), sheets[0]);
  assert.equal(resolveSkillRuntimeSheet(sheets, "不存在"), null);
});

test("creates a session-only file source in the existing request shape", () => {
  const item = createSkillRuntimeFileSource({ name: "订单.xlsx" }, {
    name: "明细", data: { headers: ["订单号"], rows: [["A-1"]] }
  });
  assert.equal(item.runtimeOnly, true);
  assert.equal(item.source.fileName, "订单.xlsx");
  assert.equal(item.name, "订单.xlsx / 明细");
  assert.deepEqual(item.data.rows, [["A-1"]]);
});

test("loads files within the remaining limit and isolates parse failures", async () => {
  const files = [{ name: "a.csv" }, { name: "b.xlsx" }, { name: "bad.csv" }];
  const result = await loadSkillRuntimeFileSources(files, {
    availableSlots: 3,
    parseFile: async (file) => {
      if (file.name === "bad.csv") throw new Error("格式错误");
      return file.name.endsWith(".xlsx")
        ? [{ name: "表1", data: { rows: [[1]] } }, { name: "表2", data: { rows: [[2]] } }]
        : [{ name: "", data: { rows: [[3]] } }];
    },
    chooseSheet: async (_file, sheets) => sheets[1]
  });
  assert.deepEqual(result.items.map((item) => item.name), ["a.csv", "b.xlsx / 表2"]);
  assert.deepEqual(result.failures, [{ fileName: "bad.csv", error: "格式错误" }]);
});

test("counts only runtime sources against the five-file limit", () => {
  const sources = [
    { sourceType: "web" },
    { runtimeOnly: true },
    { runtimeOnly: true }
  ];
  assert.equal(availableSkillRuntimeFileSlots(sources), 3);
});
