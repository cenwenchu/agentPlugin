import test from "node:test";
import assert from "node:assert/strict";
import { parseDelimitedText } from "../../src/content/spreadsheet-file.js";

test("parses quoted CSV and preserves empty cell positions", () => {
  const data = parseDelimitedText('\uFEFF订单号,说明,金额\r\nA-1,"含,逗号",100\r\nA-2,,200');
  assert.deepEqual(data.headers, ["订单号", "说明", "金额"]);
  assert.deepEqual(data.rows, [
    ["A-1", "含,逗号", "100"],
    ["A-2", "", "200"]
  ]);
  assert.equal(data.totalRowCount, 2);
});

test("detects TSV and generates labels for empty headers", () => {
  const data = parseDelimitedText("SKU\t\t库存\nS-1\t华东\t8");
  assert.deepEqual(data.headers, ["SKU", "列2", "库存"]);
  assert.deepEqual(data.rows[0], ["S-1", "华东", "8"]);
});
