import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDerivedColumnPreviewPrompt,
  buildDerivedPreviewRows,
  calculateDerivedColumnPreviewBatchSize,
  effectiveDerivedMethod,
  resolveSelectedColumns
} from "../../src/content/derived-column-request-model.js";
import { parseDerivedColumnResults } from "../../src/content/derived-column-result-parser.js";

test("resolveSelectedColumns matches normalizedHeader plus occurrence", () => {
  const resolved = resolveSelectedColumns(
    ["订单号", "订单金额", "订单金额", "状态"],
    [
      { header: "订单金额", normalizedHeader: "订单金额", occurrence: 2 },
      { header: "状态", normalizedHeader: "状态", occurrence: 1 }
    ]
  );
  assert.deepEqual(
    resolved.columns.map((item) => ({ index: item.index, header: item.header, occurrence: item.occurrence })),
    [
      { index: 2, header: "订单金额", occurrence: 2 },
      { index: 3, header: "状态", occurrence: 1 }
    ]
  );
  assert.equal(resolved.missing.length, 0);
});

test("buildDerivedPreviewRows keeps preview rows but dedupes request rows by fingerprint", () => {
  const preview = buildDerivedPreviewRows({
    headers: ["订单号", "订单金额", "状态"],
    rows: [
      ["A-1", "100", "待处理"],
      ["A-2", "100", "待处理"],
      ["A-3", "200", "已完成"]
    ],
    selectedColumns: [
      { header: "订单金额", normalizedHeader: "订单金额", occurrence: 1 },
      { header: "状态", normalizedHeader: "状态", occurrence: 1 }
    ]
  });
  assert.equal(preview.previewRows.length, 3);
  assert.equal(preview.uniqueRows.length, 2);
  assert.equal(preview.previewRows[0].fingerprint, preview.previewRows[1].fingerprint);
  assert.notEqual(preview.previewRows[1].fingerprint, preview.previewRows[2].fingerprint);
});

test("derived preview prompt falls back to default method when empty", () => {
  const method = effectiveDerivedMethod("", 1);
  assert.equal(method.usedDefault, true);
  const prompt = buildDerivedColumnPreviewPrompt({
    method: "",
    rows: [{ fingerprint: "sha256:1", content: "| 字段 | 值 |\n| --- | --- |\n| 状态 | 待处理 |" }],
    output: { maxChars: 120 }
  });
  assert.match(prompt.prompt, /默认分析方法|分析方法/);
  assert.equal(prompt.usedDefaultMethod, true);
});

test("derived preview batch size stays large for practical per-row output estimates", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    fingerprint: `sha256:${index}`,
    content: `| 字段 | 值 |\n| --- | --- |\n| 订单号 | A-${index} |`
  }));
  const batchSize = calculateDerivedColumnPreviewBatchSize({
    rows,
    method: "",
    output: { maxChars: 1000 },
    contextWindow: 64000,
    maxOutputTokens: 4096
  });
  assert.equal(batchSize, 10);
});

test("parseDerivedColumnResults supports fenced json and reports duplicate or missing fingerprints", () => {
  const parsed = parseDerivedColumnResults({
    text: [
      "```json",
      JSON.stringify({
        results: [
          { fingerprint: "sha256:a", conclusion: "高风险" },
          { fingerprint: "sha256:x", conclusion: "未知" },
          { fingerprint: "sha256:a", conclusion: "重复" }
        ]
      }),
      "```"
    ].join("\n"),
    expectedFingerprints: ["sha256:a", "sha256:b"],
    output: { maxChars: 10 }
  });
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].fingerprint, "sha256:a");
  assert.equal(parsed.results[0].conclusion, "高风险");
  assert.deepEqual(
    parsed.failures.map((item) => item.error).sort(),
    ["缺少结果", "返回了未知 fingerprint", "返回了重复 fingerprint"].sort()
  );
});

test("parseDerivedColumnResults maps payload parse failure to every expected fingerprint", () => {
  const parsed = parseDerivedColumnResults({
    text: "模型返回了一段非 JSON 文本",
    expectedFingerprints: ["sha256:a", "sha256:b"],
    output: { maxChars: 10 }
  });
  assert.equal(parsed.results.length, 0);
  assert.deepEqual(parsed.failures.map((item) => item.fingerprint), ["sha256:a", "sha256:b"]);
  for (const failure of parsed.failures) {
    assert.match(failure.error, /^结果解析失败：/);
  }
});
