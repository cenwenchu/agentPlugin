import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DERIVED_METHOD_VERSION,
  normalizeDerivedColumnSkill,
  reconcileDerivedColumnSelections,
  skillTypeOf,
  validateDerivedColumnSkill
} from "../../src/content/derived-column-model.js";
import {
  buildDerivedColumnAnalysisFingerprint,
  buildDerivedColumnRowFingerprint,
  canonicalizeSelectedColumnValues
} from "../../src/content/derived-column-fingerprint.js";

test("skillTypeOf keeps legacy skills on table-analysis", () => {
  assert.equal(skillTypeOf({}), "table-analysis");
  assert.equal(skillTypeOf({ type: "table-analysis" }), "table-analysis");
  assert.equal(skillTypeOf({ type: "derived-column" }), "derived-column");
});

test("normalizeDerivedColumnSkill restores defaults and stable selected columns", () => {
  const normalized = normalizeDerivedColumnSkill({
    id: "skill_1",
    type: "derived-column",
    selectedColumns: [
      { header: "订单金额", occurrence: 1, index: 2 },
      { header: " 订单金额 ", occurrence: 1, index: 9 },
      { normalizedHeader: "订单状态", occurrence: 2, index: "3" }
    ],
    analysisMethod: { description: "" }
  });
  assert.equal(normalized.type, "derived-column");
  assert.equal(normalized.defaultMethodVersion, DEFAULT_DERIVED_METHOD_VERSION);
  assert.deepEqual(normalized.selectedColumns, [
    { index: 2, header: "订单金额", normalizedHeader: "订单金额", occurrence: 1 },
    { index: 3, header: "订单状态", normalizedHeader: "订单状态", occurrence: 2 }
  ]);
  assert.deepEqual(normalized.output, {
    columnName: "智能分析结论",
    position: "before-first-selected-column",
    maxChars: 1000
  });
});

test("validateDerivedColumnSkill rejects empty field selections", () => {
  const result = validateDerivedColumnSkill({
    type: "derived-column",
    sources: [{ id: "source_1" }],
    selectedColumns: []
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /至少选择一列/);
});

test("normalizeDerivedColumnSkill drops stale selected columns that no longer exist in source headers", () => {
  const normalized = normalizeDerivedColumnSkill({
    type: "derived-column",
    sources: [{
      id: "source_1",
      headers: ["店铺链接", "近30天趋势 更多指标", "链接广告消耗&ROI 更多指标", "成交转化 更多指标"]
    }],
    selectedColumns: [
      { index: 2, header: "链接ROI分析 更多指标", normalizedHeader: "链接roi分析更多指标", occurrence: 1 },
      { index: 2, header: "链接广告消耗&ROI 更多指标", normalizedHeader: "链接广告消耗&roi更多指标", occurrence: 1 },
      { index: 3, header: "成交转化 更多指标", normalizedHeader: "成交转化更多指标", occurrence: 1 }
    ]
  });
  assert.deepEqual(normalized.selectedColumns, [
    { index: 2, header: "链接广告消耗&ROI 更多指标", normalizedHeader: "链接广告消耗&roi更多指标", occurrence: 1 },
    { index: 3, header: "成交转化 更多指标", normalizedHeader: "成交转化更多指标", occurrence: 1 }
  ]);
});

test("reconcileDerivedColumnSelections keeps only columns still present in current headers", () => {
  const selected = reconcileDerivedColumnSelections(
    [
      { index: 3, header: "链接ROI分析 更多指标", normalizedHeader: "链接roi分析更多指标", occurrence: 1 },
      { index: 3, header: "链接广告消耗&ROI 更多指标", normalizedHeader: "链接广告消耗&roi更多指标", occurrence: 1 },
      { index: 4, header: "广告流量转化分析 更多指标", normalizedHeader: "广告流量转化分析更多指标", occurrence: 1 }
    ],
    ["店铺链接", "近30天趋势 更多指标", "链接广告消耗&ROI 更多指标", "成交转化 更多指标"]
  );
  assert.deepEqual(selected, [
    { index: 2, header: "链接广告消耗&ROI 更多指标", normalizedHeader: "链接广告消耗&roi更多指标", occurrence: 1 }
  ]);
});

test("derived-column row fingerprint is stable after whitespace normalization", () => {
  assert.equal(
    canonicalizeSelectedColumnValues([" 1000 ", "待发货\n催单 "]),
    "1000␟待发货\n催单"
  );
  assert.equal(
    buildDerivedColumnRowFingerprint([" 1000 ", "待发货\n催单 "]),
    buildDerivedColumnRowFingerprint(["1000", "待发货\n催单"])
  );
  assert.notEqual(
    buildDerivedColumnRowFingerprint(["100"]),
    buildDerivedColumnRowFingerprint(["1000"])
  );
});

test("analysis fingerprint changes with revision, method and selected columns", () => {
  const baseSkill = {
    id: "skill_1",
    revision: 1,
    type: "derived-column",
    sources: [{ id: "source_1" }],
    selectedColumns: [{ header: "订单金额", occurrence: 1 }],
    analysisMethod: { description: "" }
  };
  const base = buildDerivedColumnAnalysisFingerprint({ skill: baseSkill, modelId: "model_a" });
  const changedRevision = buildDerivedColumnAnalysisFingerprint({
    skill: { ...baseSkill, revision: 2 },
    modelId: "model_a"
  });
  const changedMethod = buildDerivedColumnAnalysisFingerprint({
    skill: { ...baseSkill, analysisMethod: { description: "识别高风险订单" } },
    modelId: "model_a"
  });
  const changedColumns = buildDerivedColumnAnalysisFingerprint({
    skill: {
      ...baseSkill,
      selectedColumns: [{ header: "订单状态", occurrence: 1 }]
    },
    modelId: "model_a"
  });
  assert.notEqual(base, changedRevision);
  assert.notEqual(base, changedMethod);
  assert.notEqual(base, changedColumns);
});
