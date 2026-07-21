import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WORKSHEET_CELLS,
  MAX_XLSX_ENTRY_BYTES,
  MAX_XLSX_UNCOMPRESSED_BYTES,
  normalizeRows,
  parseDelimitedText
} from "../../src/content/spreadsheet-file.js";

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

test("rejects worksheets whose rectangular cell footprint is too large", () => {
  const rows = Array.from({ length: 2002 }, () => Array(500).fill("x"));
  assert.throws(() => normalizeRows(rows), /1,000,000 个单元格/);
});

test("keeps a stricter per-entry XLSX limit below the total unzip limit", () => {
  assert.equal(MAX_WORKSHEET_CELLS, 1_000_000);
  assert.ok(MAX_XLSX_ENTRY_BYTES > 10 * 1024 * 1024);
  assert.ok(MAX_XLSX_ENTRY_BYTES < MAX_XLSX_UNCOMPRESSED_BYTES);
});
