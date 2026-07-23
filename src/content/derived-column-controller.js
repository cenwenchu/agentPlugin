/**
 * @fileoverview 按列分析运行期控制器。
 */

import { STATE } from "./state.js";
import {
  DEFAULT_DERIVED_METHOD_VERSION,
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
import { locateStoredSource, alignedRowCellTexts, extractHeaders, pageKey } from "./skill-source-dom.js";
import { getRowCells, isHeaderRow, isTableFooterOrSummaryRow } from "./table-row-dom.js";
import { waitForTableDataReady } from "./table-pagination-dom.js";
import { DEFAULT_MODEL_PROFILE } from "../shared.js";

const DEFAULT_RUNTIME_RESULT_SCHEMA_VERSION = 1;
const RUNTIME_TABLE_ROW_SELECTOR = "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr";
// 运行期日志当前默认开启，便于排查跨 frame、缓存恢复和页面频控问题。
// 若后续改为统一调试开关控制，应同步更新 README / DESIGN 的日志说明。
const DERIVED_RUNTIME_DIAGNOSTICS = true;
const DERIVED_RUNTIME_RECENT_RESULT_TTL_MS = 60 * 1000;
const DERIVED_RUNTIME_PAGE_WINDOW_MS = 60 * 1000;

let runtimeSessionCounter = 0;
let runtimeObserverTimer = null;
const runtimeControllers = new Map();
const inflightDerivedBatchRequests = new Map();
const derivedRuntimePageRequestGuards = new Map();

function logDerivedRuntime(event, detail = {}, level = "info") {
  if (!DERIVED_RUNTIME_DIAGNOSTICS) return;
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
    throw new Error("字段已变化，请重新选择");
  }
  const selectedColumns = resolved.columns;
  const expectedColumnCount = headers.length;
  const rows = [];
  const candidates = Array.from(table?.querySelectorAll?.(RUNTIME_TABLE_ROW_SELECTOR) || []);
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

function countRenderableRuntimeRows(root) {
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
  if (controller?.runOptions?.manual) return true;
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
  if (controller.root) clearDerivedRuntimeSkill(controller.skillId, controller.root);
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

function shouldRetryBlockedRuntimeForListChange(controller, skill) {
  if (!isRuntimeBlockedByCooldown(controller) || !skill) return false;
  try {
    const currentListSignature = resolveControllerListSignature(controller, skill);
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
  if (recent.analysisFingerprint !== analysisFingerprint || recent.pendingSignature !== pendingSignature) return null;
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
        status,
        conclusion: matched?.conclusion || "",
        error
      });
    }
  }
  return items;
}

function resolveDerivedInsertIndex(selectedColumns = []) {
  const indexes = (Array.isArray(selectedColumns) ? selectedColumns : [])
    .map((item) => Number(item?.index))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!indexes.length) return 0;
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
  const located = locateStoredSource(source);
  if (!located.table) {
    logDerivedRuntime("locate-source-miss", {
      skillId: skill.id,
      sourceId: source.id,
      status: located.status || "missing",
      ambiguous: Boolean(located.ambiguous),
      candidateCount: located.candidateCount || 0
    }, "warn");
    throw new Error(located.status === "changed" ? "字段已变化，请重新选择" : "未找到当前数据源对应的表格");
  }
  await waitForTableDataReady(located.table, "", 5000, source.tableIndex, {
    minWaitMs: 80,
    pollIntervalMs: 80,
    stableSamples: 2,
    compareContent: true,
    waitForLoading: true
  });
  const headers = extractHeaders(located.table);
  logDerivedRuntime("locate-source-hit", {
    skillId: skill.id,
    sourceId: source.id,
    headerCount: headers.length,
    matchMethod: located.matchMethod || "",
    candidateCount: located.candidateCount || 0
  });
  return { table: located.table, headers, source };
}

async function runDerivedRuntimeSkill(controller) {
  const { skillId } = controller;
  const currentSkill = resolveControllerSkill(controller);
  const runOptions = normalizeRuntimeRunOptions(controller.runOptions);
  logDerivedRuntime("run-start", {
    skillId,
    hasControllerSkill: Boolean(controller?.skill),
    stateSkillCount: STATE.skills.length,
    sessionId: controller.sessionId,
    runOptions
  });
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
    const runtimeModel = buildRuntimeRows({
      skill,
      table: located.table,
      headers: located.headers
    });
    const output = normalizeDerivedColumnOutput(skill.output);
    const renderOptions = {
      root: located.table,
      headerCount: located.headers.length,
      insertIndex: resolveDerivedInsertIndex(runtimeModel.selectedColumns),
      outputColumnName: output.columnName
    };
    controller.lastRenderOptions = renderOptions;
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
      : await readDerivedColumnCacheEntries(
        analysisFingerprint,
        uniqueRows.map((item) => item.fingerprint),
        { ttlMs: DEFAULT_DERIVED_CACHE_TTL_MS }
      );
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
            error: ""
          });
        }
      } else {
        pendingRows.push(unique);
      }
    }
    logDerivedRuntime("cache-restored", {
      skillId,
      cachedRows: cachedRenderable.length,
      pendingFingerprints: pendingRows.length
    });
    renderDerivedRuntimeNotes(skillId, cachedRenderable, renderOptions);

    if (!pendingRows.length) {
      logDerivedRuntime("run-complete-from-cache", { skillId });
      controller.status = "complete";
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
      if (controller.sessionId !== sessionId) return;
      logDerivedRuntime("request-batch-done", {
        skillId,
        batchSize: requestedRows.length,
        responseLength: JSON.stringify({
          results: parsed.results,
          failures: parsed.failures
        }).length
      });
      const failureMap = buildRuntimeFailureMap(parsed.failures);
      hasFailures = hasFailures || parsed.failures.length > 0;
      logDerivedRuntime("parse-results", {
        skillId,
        successCount: parsed.results.length,
        failureCount: parsed.failures.length
      }, parsed.failures.length ? "warn" : "info");
      const renderableItems = buildRuntimeRenderableItems(requestedRows, parsed.resultMap, failureMap);
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
      await writeDerivedColumnCacheEntries(
        analysisFingerprint,
        parsed.results.map((item) => ({
          rowFingerprint: item.fingerprint,
          conclusion: item.conclusion
        })),
        { maxEntries: DEFAULT_DERIVED_CACHE_MAX_ENTRIES }
      );
      pendingRows = pendingRows.slice(batchSize);
      controller.lastPendingRows = pendingRows;
    }
    controller.status = hasFailures ? "partial" : "complete";
    logDerivedRuntime("run-complete", {
      skillId,
      status: controller.status
    }, hasFailures ? "warn" : "info");
  } catch (error) {
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
    controller.lastPendingRows = [];
    controller.runOptions = null;
  }
}

function ensureRuntimeObserver() {
  if (runtimeObserverTimer) return;
  logDerivedRuntime("observer-start");
  runtimeObserverTimer = setInterval(() => {
    for (const controller of runtimeControllers.values()) {
      if (controller.status === "running") continue;
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
      if (!root || !root.isConnected || renderedCellCount < rowCount) {
        logDerivedRuntime("observer-rerun", {
          skillId: controller.skillId,
          hasRoot: Boolean(root),
          rootConnected: Boolean(root?.isConnected),
          renderedCellCount,
          rowCount
        });
        controller.sessionId = nextRuntimeSessionId();
        void runDerivedRuntimeSkill(controller);
      }
    }
  }, 1500);
}

function scheduleDerivedColumnRuntime(skills = []) {
  const derivedSkills = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skillTypeOf(skill) === SKILL_TYPE_DERIVED_COLUMN);
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
      lastListSignature: ""
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
  getPageRequestGuardState,
  getPageRequestGuardState,
  isRuntimeBlockedByCooldown,
  recordDerivedRuntimePageRequest,
  resolveControllerSkill,
  resolveControllerListSignature,
  shouldRetryBlockedRuntimeForListChange,
  shouldKeepStableRenderedRuntime,
  shouldKeepManualRuntimeWhenAutoDisabled
};
