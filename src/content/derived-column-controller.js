/**
 * @fileoverview 按列分析运行期控制器。
 *
 * 负责技能自动运行调度、LLM 请求批处理、结果缓存与渲染。
 *
 * 核心流程：
 *   1. scheduleDerivedColumnRuntime / triggerDerivedColumnRuntime 创建或复用 controller
 *   2. observer（1500ms setInterval）监控 jtv1 虚拟滚动与 DOM 变化
 *      - scroll-stale 检测（scrollGeneration 变化 + 600ms 滚动静默）→ 触发重算
 *      - 占位渲染：在 LLM 飞行期间，新出现行的派生列同步插入 loading 占位 DOM，
 *        实现"列先出现，内容后填充"
 *   3. runDerivedRuntimeSkill 定位数据源 → 构建行指纹 → 查缓存 → LLM 批处理
 *      - Session Storage 双层缓存：analysisFingerprint + rowFingerprint
 *      - recent 结果复用：避免短时间内滚动回来重复请求
 *   4. stopDerivedColumnRuntime 文档级清理 + MutationObserver 实时残留回收
 *      - 多轮延时清理（1.5s / 4s / 10s）作为兜底
 *      - 30s MutationObserver 监控表格根节点，行回收重入 DOM 时立即清除残留
 *
 * 页面频控：按 pageKey + modelId 维度累计，列表内容变化只影响调度判断，
 * 不重置窗口内总请求次数。pageRequestLimitPerMinute 由 DEFAULT_MODEL_PROFILE 控制。
 */

import { STATE, web2aiDiagnosticsEnabled } from "./state.js";
import {
  DEFAULT_DERIVED_METHOD_VERSION,
  DERIVED_OUTPUT_POSITION_AFTER_LAST,
  DERIVED_OUTPUT_POSITION_AT_COLUMN,
  SKILL_TYPE_DERIVED_COLUMN,
  normalizeDerivedColumnOutput,
  normalizeDerivedColumnSkill,
  skillTypeOf
} from "./derived-column-model.js";
import {
  buildDerivedColumnAnalysisFingerprint,
  buildDerivedColumnRowFingerprint
} from "./derived-column-fingerprint.js";
import {
  DEFAULT_DERIVED_ANALYSIS_METHOD,
  buildDerivedColumnPreviewPrompt,
  calculateDerivedColumnPreviewBatchSize,
  effectiveDerivedMethod,
  resolveSelectedColumns,
  selectedRowMarkdown
} from "./derived-column-request-model.js";
import { parseDerivedColumnResults } from "./derived-column-result-parser.js";
import {
  DEFAULT_DERIVED_CACHE_MAX_ENTRIES,
  DEFAULT_DERIVED_CACHE_TTL_MS,
  removeDerivedColumnCacheEntries,
  readDerivedColumnCacheEntries,
  writeDerivedColumnCacheEntries
} from "./derived-column-cache.js";
import {
  buildDerivedRuntimeRowIdentity,
  buildDerivedRuntimeTableId
} from "./derived-column-row-identity.js";
import {
  clearDerivedRuntimeSkill,
  RUNTIME_CELL_ATTR,
  RUNTIME_HEADER_ATTR,
  renderDerivedRuntimeNotes
} from "./derived-column-renderer.js";
import { sendToBackground } from "./messaging.js";
import { locateStoredSource, alignedRowCellTexts, extractHeaders, pageKey, dataRowsInTable } from "./skill-source-dom.js";
import { getRowCells, isHeaderRow, isTableFooterOrSummaryRow } from "./table-row-dom.js";
import { waitForTableDataReady } from "./table-pagination-dom.js";
import { DEFAULT_MODEL_PROFILE } from "../shared.js";

const DEFAULT_RUNTIME_RESULT_SCHEMA_VERSION = 1;
const RUNTIME_TABLE_ROW_SELECTOR = "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr";
// 运行期日志统一走全局诊断开关（控制台 __WEB2AI_DEBUG 或配置面板"诊断日志"）。
// 默认关闭，不再后台常驻刷屏；排障时开启。README / DESIGN 的日志说明以此为准。
const DERIVED_RUNTIME_DIAGNOSTICS = web2aiDiagnosticsEnabled;
const DERIVED_RUNTIME_RECENT_RESULT_TTL_MS = 60 * 1000;
const DERIVED_RUNTIME_PAGE_WINDOW_MS = 60 * 1000;
// jtv 虚拟行会反复销毁重建；固定列宽可确保占位态、缓存态和模型结果态
// 使用同一空间，避免内容长度变化造成横向跳动。
const JTV_RUNTIME_COLUMN_WIDTH = 190;

let runtimeSessionCounter = 0;
let runtimeObserverTimer = null;
let runtimeStaleSweepCounter = 0;
const runtimeControllers = new Map();
const inflightDerivedBatchRequests = new Map();
const derivedRuntimePageRequestGuards = new Map();
// 滚动抑制：虚拟滚动会回收派生单元格，若 tick 落在滚动途中会误判"渲染缺失"
// 触发全量重跑（逐行 insertBefore 整表重排）→ 滚动越滚越卡。滚动停止 600ms 后才允许重跑。
// jtv1 额外难题：DOM 行回收换内容后，派生列 [data-web2ai-derived-column] 属性残留，
// renderedCellCount === rowCount 假阳 → 观察器不重跑。scrollGeneration 计数器解决。
let runtimeScrollQuietAt = 0;
let runtimeScrollGeneration = 0;
let runtimeScrollListenerInstalled = false;
const RUNTIME_SCROLL_QUIET_MS = 600;

function noteRuntimeScrolling() {
  runtimeScrollQuietAt = Date.now() + RUNTIME_SCROLL_QUIET_MS;
  runtimeScrollGeneration += 1;
}

function ensureRuntimeScrollListener() {
  if (runtimeScrollListenerInstalled || typeof document?.addEventListener !== "function") return;
  runtimeScrollListenerInstalled = true;
  document.addEventListener("scroll", noteRuntimeScrolling, { passive: true, capture: true });
}

function logDerivedRuntime(event, detail = {}, level = "info") {
  if (!DERIVED_RUNTIME_DIAGNOSTICS()) return;
  const payload = {
    event,
    frame: window.top === window ? "top" : "child",
    page: `${location.origin}${location.pathname}`,
    ...detail
  };
  console[level](`[web2ai.derived-runtime] ${JSON.stringify(payload)}`);
}

function buildPageRequestGuardKey(modelId = "") {
  const currentPage = pageKey(location.href) || `${location.origin}${location.pathname}`;
  const normalizedModelId = String(modelId || STATE.activeModelId || "default").trim() || "default";
  return `${currentPage}::${normalizedModelId}`;
}

// 页面访问频控按 pageKey + modelId 维度累计总额度；
// 列表内容变化只决定是否重新进入调度判断，不会重置当前窗口内的总请求次数。
function buildPageRequestListGuardKey(modelId = "", listSignature = "") {
  const baseKey = buildPageRequestGuardKey(modelId);
  const normalizedListSignature = String(listSignature || "").trim();
  return normalizedListSignature ? `${baseKey}::${normalizedListSignature}` : baseKey;
}

function getPageRequestGuardState(guardKey = "", windowMs = DERIVED_RUNTIME_PAGE_WINDOW_MS) {
  const now = Date.now();
  const state = derivedRuntimePageRequestGuards.get(guardKey) || {
    requestTimestamps: [],
    cooldownUntil: 0
  };
  state.requestTimestamps = state.requestTimestamps
    .filter((timestamp) => now - Number(timestamp || 0) <= windowMs);
  if (Number(state.cooldownUntil || 0) <= now) state.cooldownUntil = 0;
  derivedRuntimePageRequestGuards.set(guardKey, state);
  return state;
}

function canRequestDerivedRuntimePage(
  guardKey = "",
  {
    windowMs = DERIVED_RUNTIME_PAGE_WINDOW_MS,
    maxRequests = DEFAULT_MODEL_PROFILE.pageRequestLimitPerMinute
  } = {}
) {
  const state = getPageRequestGuardState(guardKey, windowMs);
  const now = Date.now();
  if (Number(state.cooldownUntil || 0) > now) {
    return {
      allowed: false,
      reason: "cooldown",
      cooldownUntil: state.cooldownUntil,
      requestCount: state.requestTimestamps.length
    };
  }
  if (state.requestTimestamps.length >= Math.max(1, Number(maxRequests) || DEFAULT_MODEL_PROFILE.pageRequestLimitPerMinute)) {
    const oldest = Number(state.requestTimestamps[0] || now);
    state.cooldownUntil = Math.max(now, oldest + windowMs);
    derivedRuntimePageRequestGuards.set(guardKey, state);
    return {
      allowed: false,
      reason: "limit",
      cooldownUntil: state.cooldownUntil,
      requestCount: state.requestTimestamps.length
    };
  }
  return {
    allowed: true,
    reason: "",
    cooldownUntil: 0,
    requestCount: state.requestTimestamps.length
  };
}

function recordDerivedRuntimePageRequest(guardKey = "", windowMs = DERIVED_RUNTIME_PAGE_WINDOW_MS) {
  const state = getPageRequestGuardState(guardKey, windowMs);
  state.requestTimestamps.push(Date.now());
  derivedRuntimePageRequestGuards.set(guardKey, state);
  return state.requestTimestamps.length;
}

function normalizeRuntimeRunOptions(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  return {
    manual: Boolean(source.manual),
    bypassPageGuard: Boolean(source.bypassPageGuard),
    ignoreCache: Boolean(source.ignoreCache),
    ignoreRecentResult: Boolean(source.ignoreRecentResult)
  };
}

function nextRuntimeSessionId() {
  runtimeSessionCounter += 1;
  return runtimeSessionCounter;
}

function clearDerivedRuntimeForMissingSkills(activeSkillIds = []) {
  const active = new Set((Array.isArray(activeSkillIds) ? activeSkillIds : []).map((item) => String(item || "").trim()).filter(Boolean));
  for (const [skillId, controller] of runtimeControllers.entries()) {
    if (active.has(skillId)) continue;
    logDerivedRuntime("clear-missing-skill", { skillId });
    controller.sessionId = nextRuntimeSessionId();
    if (controller.root) clearDerivedRuntimeSkill(skillId, controller.root);
    runtimeControllers.delete(skillId);
  }
}

function resolveControllerSkill(controller) {
  const stored = controller?.skill;
  if (stored && skillTypeOf(stored) === SKILL_TYPE_DERIVED_COLUMN) return stored;
  return STATE.skills.find((item) => item.id === controller?.skillId) || null;
}

function skillBelongsToCurrentFrame(skill) {
  const source = skill?.sources?.[0] || skill?.source;
  const expectedFrameUrl = pageKey(source?.frameUrl || "");
  return !expectedFrameUrl || expectedFrameUrl === pageKey(location.href);
}

function skillAutoRunEnabled(skill = {}) {
  return normalizeDerivedColumnSkill(skill).trigger.autoRunEnabled === true;
}

function buildRuntimeRows({
  skill,
  table,
  headers
}) {
  const normalized = normalizeDerivedColumnSkill(skill);
  const resolved = resolveSelectedColumns(headers, normalized.selectedColumns);
  if (resolved.missing.length) {
    logDerivedRuntime("selected-columns-mismatch", {
      skillId: skill.id,
      selectedColumns: (normalized.selectedColumns || []).map((item) => ({
        index: Number(item?.index),
        header: item?.header || "",
        normalizedHeader: item?.normalizedHeader || "",
        occurrence: Number(item?.occurrence) || 1
      })),
      currentHeaders: (headers || []).map((header, index) => ({
        index,
        header,
        normalizedHeader: String(header || "").trim().toLowerCase().replace(/\s+/g, "")
      })),
      missingSelections: resolved.missing.map((item) => ({
        index: Number(item?.index),
        header: item?.header || "",
        normalizedHeader: item?.normalizedHeader || "",
        occurrence: Number(item?.occurrence) || 1
      }))
    }, "warn");
    throw new Error("字段已变化，请重新选择");
  }
  const selectedColumns = resolved.columns;
  const expectedColumnCount = headers.length;
  const rows = [];
  // 行枚举优先走适配器（dataRowsInTable）：jtv1 等表格的数据行是 ._jt_row._jt_rh div，
  // 通用 RUNTIME_TABLE_ROW_SELECTOR 命中不到，反而误中根节点内嵌套的工具栏 table 行；
  // 适配器能正确识别数据行并排除嵌套工具栏表。无适配器时回退通用选择器（标准框架不变）。
  const adapterRows = dataRowsInTable(table);
  const candidates = adapterRows.length
    ? adapterRows
    : Array.from(table?.querySelectorAll?.(RUNTIME_TABLE_ROW_SELECTOR) || []);
  for (const rowEl of candidates) {
    if (!rowEl?.isConnected || isHeaderRow(rowEl) || isTableFooterOrSummaryRow(rowEl)) continue;
    const cells = getRowCells(rowEl);
    if (!cells.length) continue;
    const row = alignedRowCellTexts(cells, expectedColumnCount);
    if (!row.length || !row.some(Boolean)) continue;
    const selectedValues = selectedColumns.map((column) => String(row[column.index] ?? ""));
    const rowFingerprint = buildDerivedColumnRowFingerprint(selectedValues);
    rows.push({
      rowEl,
      row,
      rowIndex: rows.length,
      selectedValues,
      rowFingerprint
    });
    if (rows.length >= normalized.execution.maxRows) break;
  }
  return { selectedColumns, rows };
}

function buildRuntimeUniqueRows({
  rows = [],
  selectedColumns = [],
  skill
}) {
  const uniqueRows = [];
  const uniqueMap = new Map();
  const tableId = buildDerivedRuntimeTableId(skill.id, skill.sources?.[0]?.id || skill.source?.id || "");
  for (const item of rows) {
    const rowFingerprint = item.rowFingerprint || buildDerivedColumnRowFingerprint(item.selectedValues);
    const rowIdentity = buildDerivedRuntimeRowIdentity({
      rowEl: item.rowEl,
      tableId,
      rowIndex: item.rowIndex,
      rowFingerprint
    });
    const runtimeRow = {
      ...item,
      rowFingerprint,
      rowIdentity
    };
    const existing = uniqueMap.get(rowFingerprint);
    if (existing) {
      existing.instances.push(runtimeRow);
      continue;
    }
    const requestRow = {
      fingerprint: rowFingerprint,
      content: selectedRowMarkdown(selectedColumns, item.selectedValues),
      instances: [runtimeRow]
    };
    uniqueMap.set(rowFingerprint, requestRow);
    uniqueRows.push(requestRow);
  }
  return uniqueRows;
}

function buildRuntimeFailureMap(failures = []) {
  const map = new Map();
  for (const item of Array.isArray(failures) ? failures : []) {
    const fingerprint = String(item?.fingerprint || "").trim();
    if (!fingerprint || map.has(fingerprint)) continue;
    map.set(fingerprint, String(item?.error || "分析失败").trim() || "分析失败");
  }
  return map;
}

function ensureControllerResultMap(controller, analysisFingerprint = "") {
  if (!(controller?.resolvedResultMap instanceof Map) || controller.resolvedResultFingerprint !== analysisFingerprint) {
    controller.resolvedResultMap = new Map();
    controller.resolvedResultFingerprint = analysisFingerprint;
  }
  return controller.resolvedResultMap;
}

function rememberControllerResults(controller, analysisFingerprint = "", results = []) {
  const resultMap = ensureControllerResultMap(controller, analysisFingerprint);
  for (const item of Array.isArray(results) ? results : []) {
    const fingerprint = String(item?.fingerprint || item?.rowFingerprint || "").trim();
    const conclusion = String(item?.conclusion || "").trim();
    if (!fingerprint || !conclusion) continue;
    resultMap.set(fingerprint, {
      conclusion,
      needsAttention: item?.needsAttention === true
    });
  }
  return resultMap;
}

function queueRuntimeRows(controller, rows = [], maxRows = 1000) {
  if (!(controller?.queuedRowsByFingerprint instanceof Map)) controller.queuedRowsByFingerprint = new Map();
  const limit = Math.max(1, Number(maxRows) || 1000);
  for (const row of Array.isArray(rows) ? rows : []) {
    const fingerprint = String(row?.fingerprint || "").trim();
    if (!fingerprint || controller.queuedRowsByFingerprint.has(fingerprint)) continue;
    if (controller.queuedRowsByFingerprint.size >= limit) break;
    // jtv DOM 实例会被复用，队列只保存请求所需的稳定数据；真正显示时重新按
    // 当前窗口构建 instances，不能持有已经滚出视口的 rowEl。
    controller.queuedRowsByFingerprint.set(fingerprint, {
      fingerprint,
      content: String(row?.content || ""),
      instances: []
    });
  }
  return controller.queuedRowsByFingerprint.size;
}

function mergeQueuedRuntimeRows(controller, rows = [], resultMap = new Map(), { queuedFirst = false, maxRows = 1000 } = {}) {
  const queued = Array.from(controller?.queuedRowsByFingerprint?.values?.() || []);
  controller?.queuedRowsByFingerprint?.clear?.();
  const ordered = queuedFirst ? [...queued, ...rows] : [...rows, ...queued];
  const merged = [];
  const byFingerprint = new Map();
  const limit = Math.max(1, Number(maxRows) || 1000);
  for (const row of ordered) {
    const fingerprint = String(row?.fingerprint || "").trim();
    if (!fingerprint || resultMap?.has?.(fingerprint)) continue;
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.instances.push(...(Array.isArray(row?.instances) ? row.instances : []));
      continue;
    }
    if (merged.length >= limit) continue;
    const normalized = { ...row, fingerprint, instances: Array.isArray(row?.instances) ? [...row.instances] : [] };
    byFingerprint.set(fingerprint, normalized);
    merged.push(normalized);
  }
  return merged;
}

function selectRetryRuntimeRows(requestedRows = [], resultMap = new Map(), retryCounts = new Map(), maxRetries = 1) {
  const retryRows = [];
  for (const row of Array.isArray(requestedRows) ? requestedRows : []) {
    if (resultMap?.has?.(row.fingerprint)) continue;
    const attempts = Number(retryCounts.get(row.fingerprint) || 0);
    if (attempts >= Math.max(0, Number(maxRetries) || 0)) continue;
    retryCounts.set(row.fingerprint, attempts + 1);
    retryRows.push(row);
  }
  return retryRows;
}

async function persistDerivedRuntimeBatchResults({
  controller,
  analysisFingerprint = "",
  parsed = null
} = {}) {
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  // 旧滚动窗口返回时，只有分析配置仍一致才写入当前 controller 内存；不同配置
  // 的结果仍可安全写入其独立的持久缓存键，但不能覆盖新配置的即时结果表。
  if (controller?.lastAnalysisFingerprint === analysisFingerprint) {
    rememberControllerResults(controller, analysisFingerprint, results);
  }
  await writeDerivedColumnCacheEntries(
    analysisFingerprint,
    results.map((item) => ({
      rowFingerprint: item.fingerprint,
      conclusion: item.conclusion,
      needsAttention: item.needsAttention === true
    })),
    { maxEntries: DEFAULT_DERIVED_CACHE_MAX_ENTRIES }
  );
  return results.length;
}

function countRenderableRuntimeRows(root) {
  // 与 buildRuntimeRows 同基准：优先适配器行枚举，回退通用选择器。
  // jtv1 下若用通用选择器会数成工具栏行，导致虚拟滚动观察器误判"已渲染稳定"而永不重插。
  const adapterRows = dataRowsInTable(root);
  if (adapterRows.length) {
    return adapterRows.filter((rowEl) => rowEl?.isConnected && !isHeaderRow(rowEl) && !isTableFooterOrSummaryRow(rowEl)).length;
  }
  return Array.from(root?.querySelectorAll?.(RUNTIME_TABLE_ROW_SELECTOR) || [])
    .filter((rowEl) => rowEl?.isConnected && !isHeaderRow(rowEl) && !isTableFooterOrSummaryRow(rowEl))
    .length;
}

function countRenderedRuntimeCells(controller) {
  const root = controller?.root;
  if (!root?.isConnected) return 0;
  return root.querySelectorAll?.(
    `[${RUNTIME_CELL_ATTR}="${controller.skillId}"]:not([${RUNTIME_HEADER_ATTR}])`
  )?.length || 0;
}

function disconnectJtvRuntimeRowObserver(controller) {
  controller?.jtvRowObserver?.disconnect?.();
  if (controller) {
    controller.jtvRowObserver = null;
    controller.jtvRowObserverRoot = null;
    controller.jtvPlaceholderScheduled = false;
  }
}

/**
 * jtv 的表头长期存在，但可见数据行会在滚动时被销毁并重新创建。用表体级
 * MutationObserver 在同一轮 DOM 更新后补入等宽占位单元格，避免等待 1.5 秒
 * 轮询期间整列收缩；内存已有结果时同步回填，只有新行才显示分析中。
 */
function ensureJtvRuntimeRowObserver(controller) {
  const root = controller?.root;
  const body = root?.querySelector?.("#_jt_body");
  if (!body || !root.querySelector?.("#_jt_row_head")) {
    disconnectJtvRuntimeRowObserver(controller);
    return false;
  }
  if (controller.jtvRowObserver && controller.jtvRowObserverRoot === root) return true;
  disconnectJtvRuntimeRowObserver(controller);
  const observer = new MutationObserver((mutations) => {
    // 写入派生列文本本身也会触发 childList mutation；忽略这些自有变更，
    // 只处理 jtv 新行、业务单元格替换或业务内容更新，避免观察器自循环。
    const hasBusinessMutation = mutations.some((mutation) => !mutation.target?.closest?.(
      `[${RUNTIME_CELL_ATTR}="${controller.skillId}"]`
    ));
    if (!hasBusinessMutation) return;
    if (controller.jtvPlaceholderScheduled) return;
    controller.jtvPlaceholderScheduled = true;
    queueMicrotask(() => {
      controller.jtvPlaceholderScheduled = false;
      if (controller.jtvRowObserver !== observer || !controller.root?.isConnected) return;
      renderDerivedRuntimeWindowFromMemory(controller);
    });
  });
  observer.observe(body, { childList: true, subtree: true });
  controller.jtvRowObserver = observer;
  controller.jtvRowObserverRoot = root;
  return true;
}

function controllerHasFreshRenderedState(controller) {
  const root = controller?.root;
  if (!root?.isConnected) return false;
  const rowCount = countRenderableRuntimeRows(root);
  const renderedCellCount = countRenderedRuntimeCells(controller);
  return rowCount > 0 && renderedCellCount >= rowCount;
}

function shouldKeepManualRuntimeWhenAutoDisabled(controller) {
  if (!controller) return false;
  if (controller.status === "running") return true;
  if (controller?.runOptions?.manual) {
    // Manual controllers must also verify rendered state is fresh;
    // page turns invalidate the rendered state and stale columns must be cleared.
    if (!controller.root?.isConnected) return false;
    return controllerHasFreshRenderedState(controller) &&
      ["complete", "partial", "error", "blocked"].includes(String(controller.status || ""));
  }
  if (!controller.root?.isConnected) return false;
  return shouldKeepStableRenderedRuntime(controller);
}

function isRuntimeBlockedByCooldown(controller, now = Date.now()) {
  return Number(controller?.blockedUntil || 0) > now;
}

function shouldKeepStableRenderedRuntime(controller) {
  if (!controller?.root?.isConnected) return false;
  if (controllerHasFreshRenderedState(controller)) {
    return ["complete", "partial", "error", "blocked"].includes(String(controller.status || ""));
  }
  return ["complete", "partial"].includes(String(controller.status || ""));
}

function clearStaleRuntimeController(controller, reason = "stale") {
  if (!controller) return false;
  disconnectJtvRuntimeRowObserver(controller);
  if (controller.root) clearDerivedRuntimeSkill(controller.skillId, controller.root);
  // 文档级兜底清理：jtv1 虚拟滚动回收的行可能已脱离 controller.root DOM 子树
  if (typeof document !== "undefined") {
    document.querySelectorAll(
      `[data-web2ai-derived-column="${controller.skillId}"],[data-web2ai-derived-column-col="${controller.skillId}"]`
    ).forEach((node) => node.remove());
  }
  controller.root = null;
  controller.status = "idle";
  controller.runOptions = null;
  controller.blockedUntil = 0;
  controller.blockedReason = "";
  controller.blockedListSignature = "";
  controller.blockedGuardKey = "";
  runtimeControllers.delete(controller.skillId);
  logDerivedRuntime("clear-stale-runtime", {
    skillId: controller.skillId,
    reason
  });
  return true;
}

function buildPendingFingerprintSignature(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => String(item?.fingerprint || "").trim())
    .filter(Boolean)
    .join("|");
}

function buildRuntimeListSignature(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => String(item?.rowFingerprint || item?.fingerprint || "").trim())
    .filter(Boolean)
    .join("|");
}

function buildSourceChangeRetrySignature(located = {}) {
  const headers = (located?.actualHeaders || located?.headers || [])
    .map((header) => String(header || "").trim().toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean);
  return [
    String(located?.status || "missing"),
    Boolean(located?.ambiguous) ? "1" : "0",
    Number(located?.candidateCount || 0),
    headers.join("|")
  ].join("::");
}

function resolveControllerListSignature(controller, skill) {
  const root = controller?.root;
  if (!root?.isConnected || !skill) return "";
  const headers = extractHeaders(root);
  const runtimeModel = buildRuntimeRows({
    skill,
    table: root,
    headers
  });
  return buildRuntimeListSignature(runtimeModel.rows);
}

function resolveControllerBlockedSignature(controller, skill) {
  if (!skill) return "";
  if (String(controller?.blockedReason || "") === "source-changed") {
    const source = skill.sources?.[0] || skill.source;
    if (!source) return "";
    const located = locateStoredSource(source, {
      skillType: SKILL_TYPE_DERIVED_COLUMN,
      selectedColumns: skill.selectedColumns
    });
    return buildSourceChangeRetrySignature(located);
  }
  return resolveControllerListSignature(controller, skill);
}

function shouldRetryBlockedRuntimeForListChange(controller, skill) {
  if (!isRuntimeBlockedByCooldown(controller) || !skill) return false;
  try {
    const currentListSignature = resolveControllerBlockedSignature(controller, skill);
    if (!currentListSignature) return false;
    return currentListSignature !== String(controller?.blockedListSignature || "");
  } catch {
    return true;
  }
}

function restoreRecentRuntimeResults(controller, {
  analysisFingerprint = "",
  pendingRows = []
} = {}) {
  const recent = controller?.lastCompletedResult;
  if (!recent) return null;
  const pendingSignature = buildPendingFingerprintSignature(pendingRows);
  if (!analysisFingerprint || !pendingSignature) return null;
  if (recent.analysisFingerprint !== analysisFingerprint) return null;
  if (recent.pendingSignature !== pendingSignature) return null;
  if (Date.now() - Number(recent.completedAt || 0) > DERIVED_RUNTIME_RECENT_RESULT_TTL_MS) return null;
  const resultMap = new Map(Array.isArray(recent.results) ? recent.results : []);
  if (!resultMap.size) return null;
  return {
    resultMap,
    pendingSignature
  };
}

async function requestDerivedRuntimeBatch({
  analysisFingerprint = "",
  pendingRows = [],
  requestPrompt = "",
  output = {},
  modelId = ""
} = {}) {
  const pendingSignature = buildPendingFingerprintSignature(pendingRows);
  const batchKey = `${analysisFingerprint}::${pendingSignature}`;
  const existing = inflightDerivedBatchRequests.get(batchKey);
  if (existing) return existing;
  const task = (async () => {
    const response = await sendToBackground({
      type: "AI_CHAT",
      payload: {
        messages: [{ role: "user", content: requestPrompt }],
        modelId,
        debugLabel: "derived-column-runtime"
      }
    }).catch(() => null);
    if (!response?.ok) throw new Error(response?.error || "模型请求失败");
    return parseDerivedColumnResults({
      text: String(response.data?.content || ""),
      expectedFingerprints: pendingRows.map((item) => item.fingerprint),
      output
    });
  })();
  inflightDerivedBatchRequests.set(batchKey, task);
  try {
    return await task;
  } finally {
    inflightDerivedBatchRequests.delete(batchKey);
  }
}

function buildRuntimeRenderableItems(uniqueRows = [], resultMap = new Map(), failureMap = new Map()) {
  const items = [];
  for (const unique of uniqueRows) {
    const matched = resultMap.get(unique.fingerprint);
    const error = failureMap.get(unique.fingerprint) || "";
    const status = matched ? "complete" : error ? "error" : "pending";
    for (const instance of unique.instances) {
      items.push({
        rowEl: instance.rowEl,
        rowIdentity: instance.rowIdentity,
        fingerprint: unique.fingerprint,
        status,
        conclusion: matched?.conclusion || "",
        needsAttention: matched?.needsAttention || false,
        error
      });
    }
  }
  return items;
}

/**
 * 根据 output.position 和 selectedColumns 计算派生列的实际插入索引。
 *
 * - at-column + positionIndex >= 0：直接使用 positionIndex
 * - after-last-selected-column：max(selectedColumnIndexes) + 1
 * - before-first-selected-column（默认）：min(selectedColumnIndexes)
 * - 无有效 selectedColumns 时回退为 0
 */
function resolveDerivedInsertIndex(selectedColumns = [], { position = "", positionIndex = -1 } = {}) {
  if (position === DERIVED_OUTPUT_POSITION_AT_COLUMN && positionIndex >= 0) {
    return positionIndex;
  }
  const indexes = (Array.isArray(selectedColumns) ? selectedColumns : [])
    .map((item) => Number(item?.index))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!indexes.length) return 0;
  if (position === DERIVED_OUTPUT_POSITION_AFTER_LAST) {
    return Math.max(0, Math.max(...indexes) + 1);
  }
  return Math.max(0, Math.min(...indexes));
}

async function locateRuntimeSource(skill) {
  const source = skill.sources?.[0] || skill.source;
  if (!source) throw new Error("未绑定数据源");
  logDerivedRuntime("locate-source-start", {
    skillId: skill.id,
    sourceId: source.id,
    frameUrl: source.frameUrl || "",
    selector: source.selector || "",
    tableIndex: Number(source.tableIndex) || 0
  });
  const located = locateStoredSource(source, {
    skillType: SKILL_TYPE_DERIVED_COLUMN,
    selectedColumns: skill.selectedColumns
  });
  if (!located.table || located.status !== "available") {
    logDerivedRuntime("locate-source-miss", {
      skillId: skill.id,
      sourceId: source.id,
      status: located.status || "missing",
      ambiguous: Boolean(located.ambiguous),
      candidateCount: located.candidateCount || 0,
      headerCoverage: Number(located.headerCoverage || 0),
      selectedColumnCoverage: Number(located.selectedColumnCoverage || 0),
      score: Number(located.score || 0),
      expectedHeaders: located.expectedHeaders || [],
      actualHeaders: located.actualHeaders || [],
      headerDiff: located.headerDiff || null,
      missingSelectedColumns: located.selectedColumnCoverageDetail?.missing || []
    }, "warn");
    if (located.status === "changed") {
      const error = new Error("字段已变化，请重新选择");
      error.code = "SOURCE_CHANGED";
      error.blockedReason = "source-changed";
      error.retrySignature = buildSourceChangeRetrySignature(located);
      throw error;
    }
    throw new Error("未找到当前数据源对应的表格");
  }
  await waitForTableDataReady(located.table, "", 5000, source.tableIndex, {
    minWaitMs: 80,
    pollIntervalMs: 80,
    stableSamples: 2,
    compareContent: true,
    waitForLoading: true
  });
  const headers = located.headers || extractHeaders(located.table);
  logDerivedRuntime("locate-source-hit", {
    skillId: skill.id,
    sourceId: source.id,
    headerCount: headers.length,
    matchMethod: located.matchMethod || "",
    candidateCount: located.candidateCount || 0,
    headerCoverage: Number(located.headerCoverage || 0),
    selectedColumnCoverage: Number(located.selectedColumnCoverage || 0),
    score: Number(located.score || 0)
  });
  return { table: located.table, headers, source };
}

/**
 * 同步占位渲染：在 observer 检测到缺失派生列时立即插入 loading 占位 DOM，
 * 不等 async 的 locateRuntimeSource + LLM 调用完成。利用 controller 上缓存
 * 的 lastRenderOptions 避免重新走定位链路，实现"列先出现，内容后填充"。
 * jtv1 虚拟滚动场景下，用户滚动后能立即看到列占位，不必等 AI 返回。
 */
function renderDerivedRuntimePlaceholders(controller) {
  const { skillId, root, lastRenderOptions } = controller;
  if (!root?.isConnected || !lastRenderOptions) return 0;
  const adapterRows = dataRowsInTable(root);
  const candidates = adapterRows.length
    ? adapterRows
    : Array.from(root?.querySelectorAll?.(RUNTIME_TABLE_ROW_SELECTOR) || []);
  const missingRows = [];
  for (const rowEl of candidates) {
    if (!rowEl?.isConnected || isHeaderRow(rowEl) || isTableFooterOrSummaryRow(rowEl)) continue;
    if (rowEl.querySelector(`[${RUNTIME_CELL_ATTR}="${skillId}"]:not([${RUNTIME_HEADER_ATTR}])`)) continue;
    missingRows.push({ rowEl, rowIdentity: "", status: "loading", conclusion: "", error: "" });
  }
  if (!missingRows.length) return 0;
  renderDerivedRuntimeNotes(skillId, missingRows, lastRenderOptions);
  logDerivedRuntime("placeholder-render", { skillId, missingCount: missingRows.length, rowCount: candidates.length });
  return missingRows.length;
}

/**
 * 同步渲染当前 jtv 可见窗口。controller 内按行指纹累计的结果无需经过
 * storage、重新定位或滚动静默期；命中时直接写入结论，未命中才落到占位态。
 */
function renderDerivedRuntimeWindowFromMemory(controller) {
  const { root, skillId, lastRenderOptions } = controller || {};
  const skill = resolveControllerSkill(controller);
  const resultMap = controller?.resolvedResultFingerprint === controller?.lastAnalysisFingerprint &&
    controller?.resolvedResultMap instanceof Map
    ? controller.resolvedResultMap
    : new Map();
  if (!root?.isConnected || !lastRenderOptions || !skill) {
    return renderDerivedRuntimePlaceholders(controller);
  }
  try {
    const headers = extractHeaders(root);
    const runtimeModel = buildRuntimeRows({ skill, table: root, headers });
    const uniqueRows = buildRuntimeUniqueRows({
      rows: runtimeModel.rows,
      selectedColumns: runtimeModel.selectedColumns,
      skill
    });
    const items = buildRuntimeRenderableItems(uniqueRows, resultMap, new Map()).map((item) => (
      item.status === "complete" ? item : { ...item, status: "loading" }
    ));
    queueRuntimeRows(
      controller,
      uniqueRows.filter((row) => !resultMap.has(row.fingerprint)),
      normalizeDerivedColumnSkill(skill).execution.maxRows
    );
    if (!items.length) return 0;
    return renderDerivedRuntimeNotes(skillId, items, lastRenderOptions);
  } catch {
    return renderDerivedRuntimePlaceholders(controller);
  }
}

async function runDerivedRuntimeSkill(controller) {
  const { skillId } = controller;
  const currentSkill = resolveControllerSkill(controller);
  const runOptions = normalizeRuntimeRunOptions(controller.runOptions);
  if (!currentSkill || skillTypeOf(currentSkill) !== SKILL_TYPE_DERIVED_COLUMN) {
    logDerivedRuntime("run-skip-no-skill", {
      skillId,
      hasCurrentSkill: Boolean(currentSkill),
      type: currentSkill ? skillTypeOf(currentSkill) : ""
    }, "warn");
    if (controller.root) clearDerivedRuntimeSkill(skillId, controller.root);
    runtimeControllers.delete(skillId);
    return;
  }
  if (!runOptions.manual && !skillAutoRunEnabled(currentSkill)) {
    logDerivedRuntime("run-skip-auto-disabled", { skillId });
    controller.status = "idle";
    return;
  }
  if (!skillBelongsToCurrentFrame(currentSkill)) {
    logDerivedRuntime("run-skip-frame-mismatch", {
      skillId,
      currentPage: pageKey(location.href),
      expectedFrameUrl: pageKey(currentSkill?.sources?.[0]?.frameUrl || currentSkill?.source?.frameUrl || "")
    });
    if (controller.root) clearDerivedRuntimeSkill(skillId, controller.root);
    controller.root = null;
    controller.status = "idle";
    return;
  }
  const skill = normalizeDerivedColumnSkill(currentSkill);
  const sessionId = controller.sessionId;
  if (!isRuntimeBlockedByCooldown(controller)) {
    controller.blockedUntil = 0;
    controller.blockedReason = "";
    controller.blockedListSignature = "";
    controller.blockedGuardKey = "";
  }
  controller.status = "running";
  controller.lastPendingRows = [];
  try {
    const located = await locateRuntimeSource(skill);
    if (controller.sessionId !== sessionId) return;
    controller.root = located.table;
    const analysisFingerprint = buildDerivedColumnAnalysisFingerprint({
      skill,
      sourceId: located.source.id,
      modelId: STATE.activeModelId,
      resultSchemaVersion: DEFAULT_RUNTIME_RESULT_SCHEMA_VERSION
    });
    controller.lastAnalysisFingerprint = analysisFingerprint;
    const controllerResultMap = ensureControllerResultMap(controller, analysisFingerprint);
    const runtimeModel = buildRuntimeRows({
      skill,
      table: located.table,
      headers: located.headers
    });
    const output = normalizeDerivedColumnOutput(skill.output);
    const renderOptions = {
      root: located.table,
      headerCount: located.headers.length,
      insertIndex: resolveDerivedInsertIndex(runtimeModel.selectedColumns, { position: output.position, positionIndex: output.positionIndex }),
      outputColumnName: output.columnName,
      columnWidth: located.table.querySelector?.("#_jt_row_head") ? JTV_RUNTIME_COLUMN_WIDTH : undefined
    };
    controller.lastRenderOptions = renderOptions;
    ensureJtvRuntimeRowObserver(controller);
    const uniqueRows = buildRuntimeUniqueRows({
      rows: runtimeModel.rows,
      selectedColumns: runtimeModel.selectedColumns,
      skill
    });
    const currentListSignature = buildRuntimeListSignature(runtimeModel.rows);
    controller.lastListSignature = currentListSignature;
    logDerivedRuntime("rows-built", {
      skillId,
      totalRows: runtimeModel.rows.length,
      uniqueRows: uniqueRows.length,
      selectedColumnCount: runtimeModel.selectedColumns.length,
      listSignature: currentListSignature
    });
    if (!uniqueRows.length) {
      logDerivedRuntime("rows-empty", { skillId }, "warn");
      clearDerivedRuntimeSkill(skillId, located.table);
      controller.status = "idle";
      return;
    }

    const cachedMap = runOptions.ignoreCache
      ? new Map()
      : new Map(controllerResultMap);
    if (!runOptions.ignoreCache) {
      const storedCacheMap = await readDerivedColumnCacheEntries(
        analysisFingerprint,
        uniqueRows.map((item) => item.fingerprint),
        { ttlMs: DEFAULT_DERIVED_CACHE_TTL_MS }
      );
      for (const [fingerprint, result] of storedCacheMap) cachedMap.set(fingerprint, result);
      rememberControllerResults(controller, analysisFingerprint, Array.from(storedCacheMap, ([fingerprint, result]) => ({
        fingerprint,
        ...result
      })));
    }
    if (controller.sessionId !== sessionId) return;

    const cachedRenderable = [];
    let pendingRows = [];
    for (const unique of uniqueRows) {
      const cached = cachedMap.get(unique.fingerprint);
      if (cached) {
        for (const instance of unique.instances) {
          cachedRenderable.push({
            rowEl: instance.rowEl,
            rowIdentity: instance.rowIdentity,
            status: "complete",
            conclusion: cached.conclusion,
            needsAttention: cached.needsAttention === true,
            error: ""
          });
        }
      } else {
        pendingRows.push(unique);
      }
    }
    // 快速滚动期间由 jtv 行监听累计的未知行按首次出现顺序排在当前窗口之前，
    // 相同 fingerprint 会合并；已在内存命中的行会被剔除。
    pendingRows = mergeQueuedRuntimeRows(controller, pendingRows, controllerResultMap, {
      queuedFirst: true,
      maxRows: skill.execution.maxRows
    });
    renderDerivedRuntimeNotes(skillId, cachedRenderable, renderOptions);

    if (!pendingRows.length) {
      logDerivedRuntime("run-complete-from-cache", { skillId });
      controller.status = "complete";
      controller.lastScrollGeneration = runtimeScrollGeneration;
      return;
    }

    const recentRestored = runOptions.ignoreRecentResult ? null : restoreRecentRuntimeResults(controller, {
      analysisFingerprint,
      pendingRows
    });
    if (recentRestored) {
      const renderableItems = buildRuntimeRenderableItems(pendingRows, recentRestored.resultMap, new Map());
      const renderedCount = renderDerivedRuntimeNotes(skillId, renderableItems, renderOptions);
      controller.status = "complete";
      controller.lastScrollGeneration = runtimeScrollGeneration;
      logDerivedRuntime("run-complete-from-memory", {
        skillId,
        renderedCount,
        pendingFingerprints: pendingRows.length
      });
      return;
    }

    const methodInfo = effectiveDerivedMethod(
      skill.analysisMethod?.description || "",
      skill.defaultMethodVersion || DEFAULT_DERIVED_METHOD_VERSION
    );
    const settingsResponse = await sendToBackground({ type: "GET_SETTINGS", modelId: STATE.activeModelId }).catch(() => null);
    const pageGuardWindowMs = DERIVED_RUNTIME_PAGE_WINDOW_MS;
    const pageGuardMaxRequests = Math.max(
      1,
      Number(settingsResponse?.data?.pageRequestLimitPerMinute) || DEFAULT_MODEL_PROFILE.pageRequestLimitPerMinute
    );
    const pageGuardKey = buildPageRequestGuardKey(STATE.activeModelId);
    const pageListGuardKey = buildPageRequestListGuardKey(STATE.activeModelId, currentListSignature);
    let pageGuardGrantedForRun = Boolean(runOptions.bypassPageGuard);
    let hasFailures = false;
    const retryCounts = new Map();
    while (pendingRows.length) {
      const loadingRenderable = pendingRows.flatMap((unique) => unique.instances.map((instance) => ({
        rowEl: instance.rowEl,
        rowIdentity: instance.rowIdentity,
        status: "loading",
        conclusion: "",
        error: ""
      })));
      renderDerivedRuntimeNotes(skillId, loadingRenderable, renderOptions);
      const batchSize = Math.max(1, Math.min(
        skill.execution.maxBatchRows,
        calculateDerivedColumnPreviewBatchSize({
          rows: pendingRows,
          method: methodInfo.description,
          output,
          contextWindow: settingsResponse?.data?.contextWindow,
          maxOutputTokens: settingsResponse?.data?.maxOutputTokens
        })
      ));
      const requestedRows = pendingRows.slice(0, batchSize);
      controller.lastPendingRows = requestedRows;
      logDerivedRuntime("request-batch", {
        skillId,
        batchSize,
        remainingFingerprints: pendingRows.length,
        maxBatchRows: skill.execution.maxBatchRows
      });
      if (!pageGuardGrantedForRun) {
        const pageGuard = canRequestDerivedRuntimePage(pageGuardKey, {
          windowMs: pageGuardWindowMs,
          maxRequests: pageGuardMaxRequests
        });
        if (!pageGuard.allowed) {
          // pageGuardKey 控制当前页面对当前模型的总额度；
          // pageListGuardKey 仅记录这次被拦截时看到的列表版本，供后续判断列表是否已变化。
          controller.status = "blocked";
          controller.blockedUntil = Number(pageGuard.cooldownUntil || 0);
          controller.blockedReason = String(pageGuard.reason || "");
          controller.blockedListSignature = currentListSignature;
          controller.blockedGuardKey = pageListGuardKey;
          logDerivedRuntime("request-batch-blocked", {
            skillId,
            reason: pageGuard.reason,
            requestCount: pageGuard.requestCount,
            cooldownUntil: pageGuard.cooldownUntil,
            listSignature: currentListSignature,
            pageGuardKey,
            pageListGuardKey
          }, "warn");
          throw new Error("当前页面已触发访问保护；列表变化后会重新判断，但模型请求仍受当前页面总额度限制。");
        }
        pageGuardGrantedForRun = true;
      } else if (runOptions.bypassPageGuard) {
        logDerivedRuntime("request-batch-bypass", {
          skillId,
          reason: "manual-bypass"
        });
      } else {
        logDerivedRuntime("request-batch-continue", {
          skillId,
          remainingFingerprints: pendingRows.length
        });
      }
      const request = buildDerivedColumnPreviewPrompt({
        method: methodInfo.description || DEFAULT_DERIVED_ANALYSIS_METHOD,
        rows: requestedRows,
        output,
        defaultMethodVersion: skill.defaultMethodVersion
      });
      const pageRequestCount = recordDerivedRuntimePageRequest(pageGuardKey, pageGuardWindowMs);
      logDerivedRuntime("request-batch-allowed", {
        skillId,
        pageRequestCount,
        windowMs: pageGuardWindowMs,
        maxRequests: pageGuardMaxRequests,
        bypassPageGuard: runOptions.bypassPageGuard,
        pageGuardKey,
        pageListGuardKey
      });
      const parsed = await requestDerivedRuntimeBatch({
        analysisFingerprint,
        pendingRows: requestedRows,
        requestPrompt: request.prompt,
        output,
        modelId: STATE.activeModelId
      });
      // 滚动会使 sessionId 变化，但已经完成的模型结果不能丢弃。先按分析指纹和
      // 行指纹写入缓存，再决定是否还能安全更新当前（可能已被 jtv 复用）的 DOM。
      await persistDerivedRuntimeBatchResults({ controller, analysisFingerprint, parsed });
      if (controller.sessionId !== sessionId) {
        logDerivedRuntime("request-batch-stale-persisted", {
          skillId,
          successCount: parsed.results.length,
          staleSessionId: sessionId,
          currentSessionId: controller.sessionId
        });
        return;
      }
      logDerivedRuntime("request-batch-done", {
        skillId,
        batchSize: requestedRows.length,
        responseLength: JSON.stringify({
          results: parsed.results,
          failures: parsed.failures
        }).length
      });
      const failureMap = buildRuntimeFailureMap(parsed.failures);
      const retryRows = selectRetryRuntimeRows(requestedRows, parsed.resultMap, retryCounts, 1);
      const retryFingerprints = new Set(retryRows.map((row) => row.fingerprint));
      const terminalFailureMap = new Map(failureMap);
      for (const row of retryRows) terminalFailureMap.delete(row.fingerprint);
      hasFailures = hasFailures || terminalFailureMap.size > 0;
      logDerivedRuntime("parse-results", {
        skillId,
        successCount: parsed.results.length,
        failureCount: parsed.failures.length
      }, parsed.failures.length ? "warn" : "info");
      const renderableItems = buildRuntimeRenderableItems(requestedRows, parsed.resultMap, terminalFailureMap)
        .map((item) => retryFingerprints.has(item.fingerprint)
          ? { ...item, status: "loading", error: "" }
          : item);
      const renderedCount = renderDerivedRuntimeNotes(skillId, renderableItems, renderOptions);
      logDerivedRuntime("render-results", {
        skillId,
        renderedCount,
        requestFingerprintCount: requestedRows.length
      });
      if (!parsed.failures.length) {
        controller.lastCompletedResult = {
          analysisFingerprint,
          pendingSignature: buildPendingFingerprintSignature(requestedRows),
          results: Array.from(parsed.resultMap.entries()),
          completedAt: Date.now()
        };
      }
      const remainingRows = pendingRows.slice(batchSize);
      // 漏回/空结论/解析失败的行优先重试一次，避免后一批先完成而中间留下空洞；
      // 滚动期间新发现的行合并到剩余队列尾部，尽量填满下一次模型批量请求。
      pendingRows = mergeQueuedRuntimeRows(
        controller,
        [...retryRows, ...remainingRows],
        controller.resolvedResultMap,
        { queuedFirst: false, maxRows: skill.execution.maxRows }
      );
      controller.lastPendingRows = pendingRows;
    }
    controller.status = hasFailures ? "partial" : "complete";
    controller.lastScrollGeneration = runtimeScrollGeneration;
    logDerivedRuntime("run-complete", {
      skillId,
      status: controller.status
    }, hasFailures ? "warn" : "info");
  } catch (error) {
    if (controller.sessionId !== sessionId) {
      logDerivedRuntime("stale-session-error-ignored", {
        skillId,
        staleSessionId: sessionId,
        currentSessionId: controller.sessionId,
        error: String(error?.message ?? error)
      });
      return;
    }
    if (
      error?.code === "SOURCE_CHANGED" &&
      !runOptions.manual
    ) {
      controller.status = "blocked";
      controller.blockedUntil = Number.MAX_SAFE_INTEGER;
      controller.blockedReason = String(error?.blockedReason || "source-changed");
      controller.blockedListSignature = String(error?.retrySignature || "");
      controller.blockedGuardKey = "source-change";
      logDerivedRuntime("source-changed-blocked", {
        skillId,
        blockedReason: controller.blockedReason,
        blockedListSignature: controller.blockedListSignature
      }, "warn");
    }
    const blocked = controller.status === "blocked";
    controller.status = blocked ? "blocked" : "error";
    logDerivedRuntime("run-error", {
      skillId,
      error: String(error?.message ?? error),
      status: controller.status
    }, blocked ? "info" : "warn");
    const pendingItems = Array.isArray(controller.lastPendingRows) ? controller.lastPendingRows : [];
    if (pendingItems.length) {
      const renderableItems = pendingItems.flatMap((unique) => unique.instances.map((instance) => ({
        rowEl: instance.rowEl,
        rowIdentity: instance.rowIdentity,
        status: blocked ? "blocked" : "error",
        conclusion: "",
        error: blocked
          ? "当前页面已触发访问保护；列表变化后会重新判断，但模型请求仍受当前页面总额度限制。"
          : String(error?.message ?? error)
      })));
      const renderedCount = renderDerivedRuntimeNotes(skillId, renderableItems, {
        ...(controller.lastRenderOptions || {}),
        root: controller.root || controller.lastRenderOptions?.root
      });
      logDerivedRuntime("render-error", {
        skillId,
        renderedCount
      }, "warn");
    }
  } finally {
    // 旧滚动窗口不得清除或改写新窗口正在使用的运行状态。
    if (controller.sessionId === sessionId) {
      controller.lastPendingRows = [];
      if (!controller.runOptions?.manual) {
        controller.runOptions = null;
      }
    }
  }
}

function ensureRuntimeObserver() {
  if (runtimeObserverTimer) return;
  ensureRuntimeScrollListener();
  logDerivedRuntime("observer-start");
  runtimeObserverTimer = setInterval(() => {
    // 滚动途中跳过重跑判定：虚拟滚动回收单元格造成的"渲染缺失"是暂时现象，
    // 滚动停止后行会重建，届时再补插即可。避免滚动→重跑→重排→更卡的恶性循环。
    if (Date.now() < runtimeScrollQuietAt) {
      logDerivedRuntime("observer-skip-scrolling", { quietUntil: runtimeScrollQuietAt });
      return;
    }
    // 没有任何活跃或 blocked 控制器、且所有按列分析技能均为手动触发模式时，
    // 观察器不再需要持续轮询（无自动执行、无阻断重试、无渲染状态需要维护）。
    // jtv1 页面除外：虚拟滚动需要观察器检测 scrollGeneration 变化以触发重渲染。
    if (runtimeControllers.size === 0) {
      const hasBlocked = [...runtimeControllers.values()].some(
        (c) => (c.status === "blocked" || Number(c.blockedUntil) > Date.now())
      );
      if (!hasBlocked) {
        const derivedSkills = (Array.isArray(STATE.skills) ? STATE.skills : [])
          .filter((s) => skillTypeOf(s) === SKILL_TYPE_DERIVED_COLUMN);
        const hasJtv1Table = typeof document !== "undefined" && document.querySelector("#_jt_row_head");
        if (!hasJtv1Table && derivedSkills.every((s) => !skillAutoRunEnabled(s))) {
          clearInterval(runtimeObserverTimer);
          runtimeObserverTimer = null;
          logDerivedRuntime("observer-stop-idle");
          return;
        }
      }
    }
    for (const controller of runtimeControllers.values()) {
      // running 状态表示 LLM 请求正在飞行中，不应重复触发热重跑，
      // 但 jtv1 虚拟滚动在此期间可能有新行进入 DOM 且缺少派生列占位。
      // 对这些行做同步占位渲染——列先出现，AI 结果回填后更新内容。
      // 注意：不更新 lastScrollGeneration，等待 status 变 complete 后
      // 由 scroll-stale 路径触发 runDerivedRuntimeSkill 来填充内容。
      if (controller.status === "running") {
        if (controller.root?.isConnected &&
            controller.root.querySelector?.("#_jt_row_head") &&
            controller.lastScrollGeneration !== runtimeScrollGeneration) {
          renderDerivedRuntimePlaceholders(controller);
        }
        continue;
      }
      const skill = resolveControllerSkill(controller);
      if (!skill || !skillBelongsToCurrentFrame(skill)) continue;
      if (isRuntimeBlockedByCooldown(controller)) {
        if (shouldRetryBlockedRuntimeForListChange(controller, skill)) {
          controller.blockedUntil = 0;
          controller.blockedReason = "";
          controller.blockedListSignature = "";
          controller.blockedGuardKey = "";
          controller.status = "idle";
          logDerivedRuntime("observer-retry-on-list-change", {
            skillId: controller.skillId
          });
          controller.sessionId = nextRuntimeSessionId();
          void runDerivedRuntimeSkill(controller);
          continue;
        }
        logDerivedRuntime("observer-skip-cooldown", {
          skillId: controller.skillId,
          blockedUntil: controller.blockedUntil,
          reason: controller.blockedReason || "",
          blockedListSignature: controller.blockedListSignature || "",
          blockedGuardKey: controller.blockedGuardKey || ""
        });
        continue;
      }
      if (!skillAutoRunEnabled(skill) && !shouldKeepManualRuntimeWhenAutoDisabled(controller)) {
        clearStaleRuntimeController(controller, "auto-disabled-stale-page");
        continue;
      }
      const root = controller.root;
      const renderedCellCount = countRenderedRuntimeCells(controller);
      const rowCount = root?.isConnected ? countRenderableRuntimeRows(root) : 0;
      const hasJtv1Head = root?.querySelector?.("#_jt_row_head");
      const jtv1StaleSuppressed = Number(controller.jtv1StaleSuppressUntil || 0) > Date.now();
      if (
        root?.isConnected &&
        controller.lastScrollGeneration !== runtimeScrollGeneration &&
        !jtv1StaleSuppressed &&
        hasJtv1Head
      ) {
        controller.lastScrollGeneration = runtimeScrollGeneration;
        controller.jtv1StaleSuppressUntil = Date.now() + 3000;
        controller.sessionId = nextRuntimeSessionId();
        controller.runOptions = { manual: true };
        renderDerivedRuntimePlaceholders(controller);
        void runDerivedRuntimeSkill(controller);
        continue;
      }
      if (!root || !root.isConnected || countRenderedRuntimeCells(controller) < rowCount) {
        // jtv1 虚拟滚动回收 DOM 行导致 renderedCellCount < rowCount 是常态；
        // 已完成分析的 controller 由上方 scroll-stale 分支负责补渲染，
        // 此处不重复触发热重跑，避免 unnecessary 全量重跑 → 重排 → 滚动卡顿。
        if (hasJtv1Head && renderedCellCount > 0 &&
            ["complete", "partial"].includes(String(controller.status || ""))) {
          // jtv1 complete 跳过重跑，但仍同步补占位（虚拟回收后新行无列）
          renderDerivedRuntimePlaceholders(controller);
          continue;
        }
        controller.sessionId = nextRuntimeSessionId();
        controller.runOptions = { manual: true };
        renderDerivedRuntimePlaceholders(controller);
        void runDerivedRuntimeSkill(controller);
      }
    }
    // 周期性清扫：每 3 个 tick (~4.5s) 检查文档中是否存在孤儿派生列单元格
    //（controller 已删除但 DOM 残留，常见于 jtv1 虚拟滚动回收行后重入 DOM）。
    runtimeStaleSweepCounter += 1;
    if (runtimeStaleSweepCounter >= 3) {
      runtimeStaleSweepCounter = 0;
      if (typeof document !== "undefined") {
        const activeIds = new Set([...runtimeControllers.keys()]);
        const orphanCells = document.querySelectorAll(
          `[data-web2ai-derived-column]:not([data-web2ai-derived-column-header])`
        );
        let sweepRemoved = 0;
        for (const cell of orphanCells) {
          const sid = cell.getAttribute("data-web2ai-derived-column");
          if (!sid || activeIds.has(sid)) continue;
          cell.remove();
          sweepRemoved += 1;
        }
        const orphanCols = document.querySelectorAll(`[data-web2ai-derived-column-col]`);
        let sweepColsRemoved = 0;
        for (const col of orphanCols) {
          const sid = col.getAttribute("data-web2ai-derived-column-col");
          if (!sid || activeIds.has(sid)) continue;
          col.remove();
          sweepColsRemoved += 1;
        }
      }
    }
  }, 1500);
}

function scheduleDerivedColumnRuntime(skills = []) {
  const derivedSkills = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skillTypeOf(skill) === SKILL_TYPE_DERIVED_COLUMN);
  // 整表分析技能不需要启动派生列运行期。仍先清理可能存在的旧 controller，
  // 随后立即退出，避免一次技能同步在页面所有 iframe 中产生空调度和诊断日志。
  if (!derivedSkills.length) {
    clearDerivedRuntimeForMissingSkills([]);
    return;
  }
  logDerivedRuntime("schedule", {
    totalSkills: Array.isArray(skills) ? skills.length : 0,
    derivedSkillCount: derivedSkills.length
  });
  clearDerivedRuntimeForMissingSkills(derivedSkills.map((skill) => skill.id));
  for (const skill of derivedSkills) {
    const existing = runtimeControllers.get(skill.id) || null;
    if (isRuntimeBlockedByCooldown(existing)) {
      if (shouldRetryBlockedRuntimeForListChange(existing, skill)) {
        existing.skill = skill;
        existing.blockedUntil = 0;
        existing.blockedReason = "";
        existing.blockedListSignature = "";
        existing.blockedGuardKey = "";
        existing.status = "idle";
        runtimeControllers.set(skill.id, existing);
        logDerivedRuntime("schedule-retry-on-list-change", {
          skillId: skill.id
        });
      } else {
      existing.skill = skill;
      runtimeControllers.set(skill.id, existing);
      logDerivedRuntime("schedule-keep-cooldown", {
        skillId: skill.id,
        blockedUntil: existing.blockedUntil,
        reason: existing.blockedReason || "",
        blockedListSignature: existing.blockedListSignature || "",
        blockedGuardKey: existing.blockedGuardKey || ""
      });
      continue;
      }
    }
    if (!skillAutoRunEnabled(skill)) {
      if (shouldKeepManualRuntimeWhenAutoDisabled(existing)) {
        existing.skill = skill;
        runtimeControllers.set(skill.id, existing);
        logDerivedRuntime("schedule-keep-manual-when-auto-disabled", {
          skillId: skill.id,
          status: existing.status,
          hasRoot: Boolean(existing.root?.isConnected),
          manualRunPending: Boolean(existing?.runOptions?.manual)
        });
        continue;
      }
      if (existing && existing.status !== "running") {
        if (existing.root?.isConnected) {
          clearStaleRuntimeController(existing, "auto-disabled");
        } else {
          runtimeControllers.delete(skill.id);
        }
      }
      logDerivedRuntime("schedule-skip-auto-disabled", {
        skillId: skill.id
      });
      continue;
    }
    if (!skillBelongsToCurrentFrame(skill)) {
      logDerivedRuntime("schedule-skip-frame-mismatch", {
        skillId: skill.id,
        currentPage: pageKey(location.href),
        expectedFrameUrl: pageKey(skill?.sources?.[0]?.frameUrl || skill?.source?.frameUrl || "")
      });
      continue;
    }
    const nextController = existing || {
      skillId: skill.id,
      sessionId: 0,
      status: "idle",
      root: null,
      skill: null,
      runOptions: null,
      blockedUntil: 0,
      blockedReason: "",
      blockedListSignature: "",
      blockedGuardKey: "",
      lastListSignature: "",
      lastScrollGeneration: 0,
      jtv1StaleSuppressUntil: 0
    };
    if (nextController.status === "running") {
      nextController.skill = skill;
      runtimeControllers.set(skill.id, nextController);
      logDerivedRuntime("schedule-keep-running", {
        skillId: skill.id,
        sessionId: nextController.sessionId
      });
      continue;
    }
    if (shouldKeepStableRenderedRuntime(nextController)) {
      nextController.skill = skill;
      runtimeControllers.set(skill.id, nextController);
      logDerivedRuntime("schedule-keep-stable", {
        skillId: skill.id,
        sessionId: nextController.sessionId,
        status: nextController.status,
        renderedCellCount: countRenderedRuntimeCells(nextController),
        rowCount: countRenderableRuntimeRows(nextController.root)
      });
      continue;
    }
    if ((nextController.status === "complete" || nextController.status === "partial") && nextController.root?.isConnected) {
      nextController.skill = skill;
      runtimeControllers.set(skill.id, nextController);
      logDerivedRuntime("schedule-keep-complete-root", {
        skillId: skill.id,
        sessionId: nextController.sessionId,
        status: nextController.status
      });
      continue;
    }
    nextController.skill = skill;
    nextController.sessionId = nextRuntimeSessionId();
    nextController.status = "idle";
    runtimeControllers.set(skill.id, nextController);
    logDerivedRuntime("schedule-skill", {
      skillId: skill.id,
      sourceId: skill.sources?.[0]?.id || skill.source?.id || "",
      sessionId: nextController.sessionId
    });
    void runDerivedRuntimeSkill(nextController);
  }
  if (derivedSkills.length) ensureRuntimeObserver();
}

export {
  scheduleDerivedColumnRuntime
};

function triggerDerivedColumnRuntime(skill, options = {}) {
  if (!skill || skillTypeOf(skill) !== SKILL_TYPE_DERIVED_COLUMN) return false;
  if (!skillBelongsToCurrentFrame(skill)) return false;
  const existing = runtimeControllers.get(skill.id) || {
    skillId: skill.id,
    sessionId: 0,
    status: "idle",
    root: null,
    skill: null,
    runOptions: null,
    blockedUntil: 0,
    blockedReason: "",
    blockedListSignature: "",
    blockedGuardKey: "",
    lastListSignature: ""
  };
  existing.skill = skill;
  existing.runOptions = normalizeRuntimeRunOptions(options);
  existing.sessionId = nextRuntimeSessionId();
  existing.status = "idle";
  existing.blockedUntil = 0;
  existing.blockedReason = "";
  existing.blockedListSignature = "";
  existing.blockedGuardKey = "";
  runtimeControllers.set(skill.id, existing);
  logDerivedRuntime("trigger-manual-run", {
    skillId: skill.id,
    runOptions: existing.runOptions,
    sessionId: existing.sessionId
  });
  void runDerivedRuntimeSkill(existing);
  return true;
}

export {
  triggerDerivedColumnRuntime
};

async function stopDerivedColumnRuntime(skillId = "", { clearUi = true, clearHistory = false } = {}) {
  const normalizedSkillId = String(skillId || "").trim();
  if (!normalizedSkillId) return false;
  const existing = runtimeControllers.get(normalizedSkillId);
  disconnectJtvRuntimeRowObserver(existing);
  if (clearUi && typeof document !== "undefined") {
    // 文档级清理：jtv1 虚拟滚动回收的行可能已脱离 controller.root DOM 子树，
    // 需在文档级确保所有派生列单元格（含 colgroup/col 占位）被移除。
    const cells = document.querySelectorAll(
      `[data-web2ai-derived-column="${normalizedSkillId}"],[data-web2ai-derived-column-col="${normalizedSkillId}"]`
    );
    cells.forEach((node) => node.remove());
    // 即时清理无法覆盖虚拟滚动回收后重新注入 DOM 的残留单元格。
    // 在表格根节点上挂 MutationObserver：监听到新增子节点时实时清除残留，
    // 不再依赖定时轮询的时间窗口。
    const cleanupRoot = existing?.root;
    if (cleanupRoot?.isConnected) {
      const residualObserver = new MutationObserver((mutations) => {
        // 技能被重新启用后不再清理新产生的派生列
        if (runtimeControllers.has(normalizedSkillId)) return;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.hasAttribute?.("data-web2ai-derived-column") &&
                node.getAttribute("data-web2ai-derived-column") === normalizedSkillId) {
              node.remove();
              continue;
            }
            if (node.hasAttribute?.("data-web2ai-derived-column-col") &&
                node.getAttribute("data-web2ai-derived-column-col") === normalizedSkillId) {
              node.remove();
              continue;
            }
            const residual = node.querySelectorAll?.(
              `[data-web2ai-derived-column="${normalizedSkillId}"],[data-web2ai-derived-column-col="${normalizedSkillId}"]`
            );
            residual.forEach((n) => n.remove());
          }
        }
      });
      residualObserver.observe(cleanupRoot, { childList: true, subtree: true });
      setTimeout(() => residualObserver.disconnect(), 30000);
      logDerivedRuntime("stop-residual-observer", { skillId: normalizedSkillId });
    }
    // 延时清理作为兜底：覆盖 observer 未捕获的场景（如根节点变化、scroll container 之外的行）
    [1500, 4000, 10000].forEach((delay) => {
      setTimeout(() => {
        if (typeof document === "undefined") return;
        const delayed = document.querySelectorAll(
          `[data-web2ai-derived-column="${normalizedSkillId}"],[data-web2ai-derived-column-col="${normalizedSkillId}"]`
        );
        if (!delayed.length) return;
        delayed.forEach((node) => node.remove());
        logDerivedRuntime("stop-delayed-cleanup", { skillId: normalizedSkillId, removedCount: delayed.length, delayMs: delay });
      }, delay);
    });
  }
  if (!existing) return false;
  existing.sessionId = nextRuntimeSessionId();
  existing.status = "idle";
  existing.runOptions = null;
  existing.blockedUntil = 0;
  existing.blockedReason = "";
  existing.blockedListSignature = "";
  existing.blockedGuardKey = "";
  existing.lastListSignature = "";
  if (clearUi && existing.root) clearDerivedRuntimeSkill(normalizedSkillId, existing.root);
  if (clearHistory) {
    existing.lastCompletedResult = null;
    if (existing.lastAnalysisFingerprint) {
      await removeDerivedColumnCacheEntries(existing.lastAnalysisFingerprint).catch(() => void 0);
    }
  }
  existing.root = clearUi ? null : existing.root;
  runtimeControllers.delete(normalizedSkillId);
  logDerivedRuntime("stop-runtime", {
    skillId: normalizedSkillId,
    clearUi,
    clearHistory
  });
  return true;
}

export {
  stopDerivedColumnRuntime
};

export const __test = {
  buildSourceChangeRetrySignature,
  clearStaleRuntimeController,
  normalizeRuntimeRunOptions,
  buildPageRequestGuardKey,
  buildPageRequestListGuardKey,
  buildRuntimeFailureMap,
  buildRuntimeListSignature,
  buildRuntimeRows,
  buildRuntimeUniqueRows,
  canRequestDerivedRuntimePage,
  countRenderableRuntimeRows,
  disconnectJtvRuntimeRowObserver,
  ensureJtvRuntimeRowObserver,
  getPageRequestGuardState,
  ensureControllerResultMap,
  mergeQueuedRuntimeRows,
  getPageRequestGuardState,
  isRuntimeBlockedByCooldown,
  recordDerivedRuntimePageRequest,
  renderDerivedRuntimeWindowFromMemory,
  persistDerivedRuntimeBatchResults,
  queueRuntimeRows,
  rememberControllerResults,
  resolveControllerSkill,
  resolveControllerListSignature,
  resolveDerivedInsertIndex,
  shouldRetryBlockedRuntimeForListChange,
  selectRetryRuntimeRows,
  shouldKeepStableRenderedRuntime,
  shouldKeepManualRuntimeWhenAutoDisabled
};
