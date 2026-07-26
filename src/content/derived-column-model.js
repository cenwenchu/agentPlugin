/**
 * @fileoverview 按列分析技能的纯数据模型与兼容归一化。
 *
 * 派生列（derived column）技能会在原始表格中插入一个新列，
 * 其输出位置由 output.position 控制，支持三种模式：
 *   - before-first-selected-column：插入到所选列的最前面（默认）
 *   - after-last-selected-column：插入到所选列的最后面
 *   - at-column：指定列号（配合 output.positionIndex 使用）
 * 历史技能未设置 position 时自动回退为默认值，保证向后兼容。
 */

const SKILL_TYPE_TABLE_ANALYSIS = "table-analysis";
const SKILL_TYPE_DERIVED_COLUMN = "derived-column";
const DEFAULT_DERIVED_METHOD_VERSION = 1;
const DEFAULT_DERIVED_OUTPUT_COLUMN_NAME = "智能分析结论";
// 派生列插入位置常量：决定新列放在所选字段的哪个位置
const DERIVED_OUTPUT_POSITION_BEFORE_FIRST = "before-first-selected-column";
const DERIVED_OUTPUT_POSITION_AFTER_LAST = "after-last-selected-column";
const DERIVED_OUTPUT_POSITION_AT_COLUMN = "at-column";
const VALID_DERIVED_OUTPUT_POSITIONS = new Set([
  DERIVED_OUTPUT_POSITION_BEFORE_FIRST,
  DERIVED_OUTPUT_POSITION_AFTER_LAST,
  DERIVED_OUTPUT_POSITION_AT_COLUMN
]);
const DEFAULT_DERIVED_OUTPUT_POSITION = DERIVED_OUTPUT_POSITION_BEFORE_FIRST;
const DEFAULT_DERIVED_OUTPUT_POSITION_INDEX = -1;
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

function reconcileDerivedColumnSelections(columns = [], headers = []) {
  const normalized = normalizeDerivedColumnSelections(columns);
  const sourceHeaders = Array.isArray(headers) ? headers : [];
  if (!sourceHeaders.length) return normalized;
  const available = new Map();
  for (let index = 0; index < sourceHeaders.length; index++) {
    const header = normalizeWhitespace(sourceHeaders[index]);
    const normalizedHeader = normalizedHeaderText(header);
    if (!normalizedHeader) continue;
    const occurrence = sourceHeaders
      .slice(0, index + 1)
      .filter((item) => normalizedHeaderText(item) === normalizedHeader)
      .length || 1;
    available.set(`${normalizedHeader}#${occurrence}`, {
      index,
      header,
      normalizedHeader,
      occurrence
    });
  }
  return normalized
    .map((column) => available.get(derivedColumnSelectionKey(column)) || null)
    .filter(Boolean);
}

function normalizeDerivedColumnAnalysisMethod(method = {}) {
  if (typeof method === "string") return { description: method.trim() };
  return { description: String(method?.description || "").replace(/\r\n?/g, "\n").trim() };
}

/**
 * 归一化派生列输出配置，包括列名、插入位置和最大字符数。
 * position 做白名单校验，非法或缺失时回退为 before-first-selected-column；
 * positionIndex 仅在 at-column 模式下有意义，其他模式统一为 -1。
 */
function normalizeDerivedColumnOutput(output = {}) {
  const position = VALID_DERIVED_OUTPUT_POSITIONS.has(output?.position)
    ? output.position
    : DEFAULT_DERIVED_OUTPUT_POSITION;
  const positionIndex = position === DERIVED_OUTPUT_POSITION_AT_COLUMN
    ? normalizeNonNegativeInteger(output?.positionIndex, DEFAULT_DERIVED_OUTPUT_POSITION_INDEX)
    : DEFAULT_DERIVED_OUTPUT_POSITION_INDEX;
  return {
    columnName: String(output?.columnName || DEFAULT_DERIVED_OUTPUT_COLUMN_NAME).trim() || DEFAULT_DERIVED_OUTPUT_COLUMN_NAME,
    position,
    positionIndex,
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
  const primarySource = (Array.isArray(skill.sources) && skill.sources.length ? skill.sources[0] : skill.source) || null;
  return {
    ...skill,
    type: SKILL_TYPE_DERIVED_COLUMN,
    selectedColumns: reconcileDerivedColumnSelections(skill.selectedColumns, primarySource?.headers || []),
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
  DERIVED_OUTPUT_POSITION_BEFORE_FIRST,
  DERIVED_OUTPUT_POSITION_AFTER_LAST,
  DERIVED_OUTPUT_POSITION_AT_COLUMN,
  DEFAULT_DERIVED_OUTPUT_COLUMN_NAME,
  DEFAULT_DERIVED_OUTPUT_POSITION,
  DEFAULT_DERIVED_OUTPUT_POSITION_INDEX,
  DEFAULT_DERIVED_OUTPUT_MAX_CHARS,
  DEFAULT_DERIVED_TRIGGER_MODE,
  DEFAULT_DERIVED_TRIGGER_AUTO_RUN_ENABLED,
  DEFAULT_DERIVED_EXECUTION_SCOPE,
  DEFAULT_DERIVED_MAX_ROWS,
  DEFAULT_DERIVED_MAX_BATCH_ROWS,
  derivedColumnSelectionKey,
  isDerivedColumnSkill,
  reconcileDerivedColumnSelections,
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
