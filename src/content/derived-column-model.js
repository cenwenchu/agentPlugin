/**
 * @fileoverview 派生列技能的纯数据模型与兼容归一化。
 */

const SKILL_TYPE_TABLE_ANALYSIS = "table-analysis";
const SKILL_TYPE_DERIVED_COLUMN = "derived-column";
const DEFAULT_DERIVED_METHOD_VERSION = 1;
const DEFAULT_DERIVED_OUTPUT_COLUMN_NAME = "智能分析结论";
const DEFAULT_DERIVED_OUTPUT_POSITION = "before-first-selected-column";
const DEFAULT_DERIVED_OUTPUT_MAX_CHARS = 1000;
const DEFAULT_DERIVED_TRIGGER_MODE = "page-load";
const DEFAULT_DERIVED_TRIGGER_AUTO_RUN_ENABLED = false;
const DEFAULT_DERIVED_EXECUTION_SCOPE = "current-page";
const DEFAULT_DERIVED_MAX_ROWS = 100;
const DEFAULT_DERIVED_MAX_BATCH_ROWS = 20;

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedHeaderText(value) {
  return normalizeWhitespace(value).toLowerCase().replace(/\s+/g, "");
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Math.trunc(Number(value));
  return numeric > 0 ? numeric : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const numeric = Math.trunc(Number(value));
  return numeric >= 0 ? numeric : fallback;
}

function skillTypeOf(skill = {}) {
  return skill?.type === SKILL_TYPE_DERIVED_COLUMN
    ? SKILL_TYPE_DERIVED_COLUMN
    : SKILL_TYPE_TABLE_ANALYSIS;
}

function normalizeDerivedColumnSelection(column = {}) {
  const header = normalizeWhitespace(column.header || column.normalizedHeader || "");
  const normalizedHeader = normalizedHeaderText(column.normalizedHeader || header);
  if (!normalizedHeader) return null;
  return {
    index: normalizeNonNegativeInteger(column.index, 0),
    header: header || String(column.header || column.normalizedHeader || "").trim(),
    normalizedHeader,
    occurrence: normalizePositiveInteger(column.occurrence, 1)
  };
}

function derivedColumnSelectionKey(column = {}) {
  const normalized = normalizeDerivedColumnSelection(column);
  return normalized ? `${normalized.normalizedHeader}#${normalized.occurrence}` : "";
}

function normalizeDerivedColumnSelections(columns = []) {
  const seen = new Set();
  const normalized = [];
  for (const column of Array.isArray(columns) ? columns : []) {
    const item = normalizeDerivedColumnSelection(column);
    const key = derivedColumnSelectionKey(item);
    if (!item || !key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
    if (normalized.length >= 10) break;
  }
  return normalized;
}

function normalizeDerivedColumnAnalysisMethod(method = {}) {
  if (typeof method === "string") return { description: method.trim() };
  return { description: String(method?.description || "").replace(/\r\n?/g, "\n").trim() };
}

function normalizeDerivedColumnOutput(output = {}) {
  return {
    columnName: String(output?.columnName || DEFAULT_DERIVED_OUTPUT_COLUMN_NAME).trim() || DEFAULT_DERIVED_OUTPUT_COLUMN_NAME,
    position: output?.position === DEFAULT_DERIVED_OUTPUT_POSITION
      ? DEFAULT_DERIVED_OUTPUT_POSITION
      : DEFAULT_DERIVED_OUTPUT_POSITION,
    maxChars: Math.min(1000, Math.max(1, normalizePositiveInteger(output?.maxChars, DEFAULT_DERIVED_OUTPUT_MAX_CHARS)))
  };
}

function normalizeDerivedColumnTrigger(trigger = {}) {
  return {
    mode: trigger?.mode === DEFAULT_DERIVED_TRIGGER_MODE
      ? DEFAULT_DERIVED_TRIGGER_MODE
      : DEFAULT_DERIVED_TRIGGER_MODE,
    autoRunEnabled: trigger?.autoRunEnabled === true
      ? true
      : DEFAULT_DERIVED_TRIGGER_AUTO_RUN_ENABLED
  };
}

function normalizeDerivedColumnExecution(execution = {}) {
  return {
    scope: execution?.scope === DEFAULT_DERIVED_EXECUTION_SCOPE
      ? DEFAULT_DERIVED_EXECUTION_SCOPE
      : DEFAULT_DERIVED_EXECUTION_SCOPE,
    maxRows: Math.min(1000, Math.max(1, normalizePositiveInteger(execution?.maxRows, DEFAULT_DERIVED_MAX_ROWS))),
    maxBatchRows: Math.min(20, Math.max(1, normalizePositiveInteger(execution?.maxBatchRows, DEFAULT_DERIVED_MAX_BATCH_ROWS)))
  };
}

function normalizeDerivedColumnSkill(skill = {}) {
  const analysisMethod = normalizeDerivedColumnAnalysisMethod(skill.analysisMethod);
  const defaultMethodVersion = normalizePositiveInteger(
    skill.defaultMethodVersion || skill.analysisMethod?.defaultMethodVersion,
    DEFAULT_DERIVED_METHOD_VERSION
  );
  return {
    ...skill,
    type: SKILL_TYPE_DERIVED_COLUMN,
    selectedColumns: normalizeDerivedColumnSelections(skill.selectedColumns),
    analysisMethod,
    defaultMethodVersion,
    output: normalizeDerivedColumnOutput(skill.output),
    trigger: normalizeDerivedColumnTrigger(skill.trigger),
    execution: normalizeDerivedColumnExecution(skill.execution)
  };
}

function isDerivedColumnSkill(skill = {}) {
  return skillTypeOf(skill) === SKILL_TYPE_DERIVED_COLUMN;
}

function validateDerivedColumnSkill(skill = {}) {
  const normalized = normalizeDerivedColumnSkill(skill);
  const errors = [];
  if (!normalized.sources?.length && !normalized.source) errors.push("请至少绑定一个数据源");
  if (normalized.selectedColumns.length < 1) errors.push("请至少选择一列");
  if (normalized.selectedColumns.length > 10) errors.push("最多选择 10 列");
  return { normalized, valid: errors.length === 0, errors };
}

export {
  SKILL_TYPE_TABLE_ANALYSIS,
  SKILL_TYPE_DERIVED_COLUMN,
  DEFAULT_DERIVED_METHOD_VERSION,
  DEFAULT_DERIVED_OUTPUT_COLUMN_NAME,
  DEFAULT_DERIVED_OUTPUT_POSITION,
  DEFAULT_DERIVED_OUTPUT_MAX_CHARS,
  DEFAULT_DERIVED_TRIGGER_MODE,
  DEFAULT_DERIVED_TRIGGER_AUTO_RUN_ENABLED,
  DEFAULT_DERIVED_EXECUTION_SCOPE,
  DEFAULT_DERIVED_MAX_ROWS,
  DEFAULT_DERIVED_MAX_BATCH_ROWS,
  derivedColumnSelectionKey,
  isDerivedColumnSkill,
  normalizeDerivedColumnAnalysisMethod,
  normalizeDerivedColumnExecution,
  normalizeDerivedColumnOutput,
  normalizeDerivedColumnSelection,
  normalizeDerivedColumnSelections,
  normalizeDerivedColumnSkill,
  normalizedHeaderText,
  skillTypeOf,
  validateDerivedColumnSkill
};
