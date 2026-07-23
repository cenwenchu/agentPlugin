/**
 * @fileoverview 按列分析测试预览的请求装配逻辑。
 */

import { buildDerivedColumnRowFingerprint } from "./derived-column-fingerprint.js";
import {
  DEFAULT_DERIVED_METHOD_VERSION,
  normalizeDerivedColumnOutput,
  normalizeDerivedColumnSelections,
  normalizedHeaderText
} from "./derived-column-model.js";
import { calculateSkillRequestBudget } from "./skill-request-model.js";
import { estimateTokens } from "./token-budget.js";

const DEFAULT_DERIVED_PREVIEW_ROWS = 20;
const DERIVED_PREVIEW_MAX_BATCH_ROWS = 20;
const DERIVED_PREVIEW_ESTIMATED_OUTPUT_CHARS = 160;
const DEFAULT_DERIVED_ANALYSIS_METHOD = [
  "根据所选字段识别异常、风险、矛盾和值得关注的业务事项，",
  "并为每条数据生成简短明确的结论。"
].join("");

function text(value) {
  return String(value ?? "").trim();
}

function markdownCell(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function resolveSelectedColumns(headers = [], selectedColumns = []) {
  const normalizedSelections = normalizeDerivedColumnSelections(selectedColumns);
  const headerMeta = (Array.isArray(headers) ? headers : []).map((header, index) => ({
    index,
    header,
    normalizedHeader: normalizedHeaderText(header)
  }));
  const resolved = [];
  const missing = [];
  for (const selection of normalizedSelections) {
    const matches = headerMeta.filter((item) => item.normalizedHeader === selection.normalizedHeader);
    const match = matches[selection.occurrence - 1];
    if (!match) {
      missing.push(selection);
      continue;
    }
    resolved.push({
      ...selection,
      index: match.index,
      header: match.header,
      displayHeader: selection.header || match.header
    });
  }
  return { columns: resolved, missing };
}

function extractSelectedRowValues(row = [], resolvedColumns = []) {
  return resolvedColumns.map((column) => String(Array.isArray(row) ? row[column.index] ?? "" : ""));
}

function selectedRowMarkdown(resolvedColumns = [], rowValues = []) {
  const lines = [
    "| 字段 | 值 |",
    "| --- | --- |"
  ];
  resolvedColumns.forEach((column, index) => {
    lines.push(`| ${markdownCell(column.displayHeader || column.header)} | ${markdownCell(rowValues[index] || "")} |`);
  });
  return lines.join("\n");
}

function effectiveDerivedMethod(method, defaultMethodVersion = DEFAULT_DERIVED_METHOD_VERSION) {
  const description = text(method);
  return {
    description: description || DEFAULT_DERIVED_ANALYSIS_METHOD,
    defaultMethodVersion: description ? null : Math.max(1, Number(defaultMethodVersion) || DEFAULT_DERIVED_METHOD_VERSION),
    usedDefault: !description
  };
}

function buildDerivedPreviewRows({ headers = [], rows = [], selectedColumns = [], limit = DEFAULT_DERIVED_PREVIEW_ROWS } = {}) {
  const resolvedSelection = resolveSelectedColumns(headers, selectedColumns);
  const limitedRows = (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, Math.min(DEFAULT_DERIVED_PREVIEW_ROWS, limit)));
  const previewRows = limitedRows.map((row, index) => {
    const selectedValues = extractSelectedRowValues(row, resolvedSelection.columns);
    return {
      index,
      row,
      selectedValues,
      fingerprint: buildDerivedColumnRowFingerprint(selectedValues)
    };
  });
  const uniqueRows = [];
  const seen = new Set();
  for (const row of previewRows) {
    if (seen.has(row.fingerprint)) continue;
    seen.add(row.fingerprint);
    uniqueRows.push({
      fingerprint: row.fingerprint,
      content: selectedRowMarkdown(resolvedSelection.columns, row.selectedValues),
      selectedValues: row.selectedValues
    });
    if (uniqueRows.length >= DERIVED_PREVIEW_MAX_BATCH_ROWS) break;
  }
  return {
    resolvedSelection,
    previewRows,
    uniqueRows
  };
}

function buildDerivedColumnPreviewPrompt({
  method = "",
  rows = [],
  output = {},
  defaultMethodVersion = DEFAULT_DERIVED_METHOD_VERSION
} = {}) {
  const normalizedOutput = normalizeDerivedColumnOutput(output);
  const effectiveMethodInfo = effectiveDerivedMethod(method, defaultMethodVersion);
  const payload = {
    rows: rows.map((row) => ({
      fingerprint: row.fingerprint,
      content: row.content
    }))
  };
  return {
    methodText: effectiveMethodInfo.description,
    usedDefaultMethod: effectiveMethodInfo.usedDefault,
    prompt: [
      "你正在执行按列分析测试预览。",
      "请逐条阅读输入数据，只输出 JSON，不要输出解释、Markdown、标题或额外文本。",
      `分析方法：${effectiveMethodInfo.description}`,
      `单条结论要求：简短明确，不超过 ${normalizedOutput.maxChars} 个字符。`,
      "返回格式必须是：",
      '{"results":[{"fingerprint":"sha256:...","conclusion":"..."}]}',
      "要求：",
      "1. 必须按 fingerprint 返回结果；",
      "2. 不得返回未知 fingerprint；",
      "3. 每个 fingerprint 只能出现一次；",
      "4. 若无法判断，也请给出简短结论，不要留空；",
      `输入数据：\n${JSON.stringify(payload, null, 2)}`
    ].join("\n\n")
  };
}

function calculateDerivedColumnPreviewBatchSize({
  rows = [],
  method = "",
  output = {},
  contextWindow = 64000,
  maxOutputTokens = 4096,
  reserveTokens = 512
} = {}) {
  if (!rows.length) return 0;
  const normalizedOutput = normalizeDerivedColumnOutput(output);
  const inputBudget = calculateSkillRequestBudget({
    contextWindow,
    maxOutputTokens,
    method,
    reserveTokens
  });
  let usedInputTokens = 0;
  let maxRowsByInput = 0;
  for (const row of rows.slice(0, DERIVED_PREVIEW_MAX_BATCH_ROWS)) {
    const rowTokens = estimateTokens(JSON.stringify({
      fingerprint: row.fingerprint,
      content: row.content
    })) + 8;
    if (usedInputTokens + rowTokens > inputBudget.maxChars) break;
    usedInputTokens += rowTokens;
    maxRowsByInput += 1;
  }
  const responseWrapperTokens = estimateTokens('{"results":[]}') + 16;
  const singleResultTokens = estimateTokens(JSON.stringify({
    fingerprint: "sha256:".padEnd(71, "x"),
    conclusion: "中".repeat(Math.max(
      40,
      Math.min(DERIVED_PREVIEW_ESTIMATED_OUTPUT_CHARS, normalizedOutput.maxChars)
    ))
  })) + 8;
  const maxRowsByOutput = Math.max(
    1,
    Math.floor((Math.max(512, Number(maxOutputTokens) || 4096) - responseWrapperTokens) / Math.max(1, singleResultTokens))
  );
  return Math.max(1, Math.min(
    DERIVED_PREVIEW_MAX_BATCH_ROWS,
    rows.length,
    maxRowsByInput || 1,
    maxRowsByOutput
  ));
}

export {
  DEFAULT_DERIVED_ANALYSIS_METHOD,
  DEFAULT_DERIVED_PREVIEW_ROWS,
  DERIVED_PREVIEW_MAX_BATCH_ROWS,
  buildDerivedColumnPreviewPrompt,
  buildDerivedPreviewRows,
  calculateDerivedColumnPreviewBatchSize,
  effectiveDerivedMethod,
  resolveSelectedColumns,
  selectedRowMarkdown
};
