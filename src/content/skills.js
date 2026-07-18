/**
 * @fileoverview 技能的数据源绑定、持久化、页面挂接与数据采集。
 *
 * 本模块运行在所有 frame：目标 frame 负责定位表格、分页及虚拟滚动采集；
 * top frame 负责技能目录、页面归属和状态汇总。模型调用与全屏交互位于 overlay.js。
 */

import { IS_TOP_FRAME, STATE, compactOneLine, refs, uid } from "./state.js";
import { getCssSelector, isVisibleElement } from "./dom.js";
import { showToast } from "./toast.js";
import { showConfirmDialog, showPromptDialog } from "./dialog.js";
import { classifyScrollCollection, nextVirtualScrollTop, shouldStopAfterNoProgress } from "./skill-collection-model.js";
import {
  clickElement, findHeaderRowAbove, findLiveTableAfterPageTurn, findPaginationNextButton,
  getRowCells, getStableTableRoot, getTableContentDigest, getTableRowTexts, isHeaderRow,
  waitForTableChange, waitForTableDataReady
} from "./table.js";

const STORAGE_KEY = "web2aiSkills";
const PAGE_NAMES_STORAGE_KEY = "web2aiSkillPageNames";
const TABLE_SELECTOR = [
  "table", '[role="table"]', '[role="grid"]', '[role="treegrid"]',
  ".art-table", ".ant-table-wrapper", ".arco-table"
].join(",");

let renderCallback = () => void 0;
let activePickSession = "";
let cancelActivePick = null;
let observedPageKey = "";
let pageWatchTimer = null;
let skillBarTimer = null;
let skillBarBroadcastTimer = null;
let lastSkillBarDiagnostic = "";
let lastSkillBarDiagnosticAt = 0;
const activeCollections = new Map();
// 默认关闭，避免在业务页面控制台持续输出采集轨迹。真实站点排障时可临时
// 改为 true；所有采集日志都通过 logSkillCollection 这一处控制。
const SKILL_COLLECTION_DIAGNOSTICS = false;

function emptyAnalysisMethod() {
  return { description: "" };
}

function normalizeAnalysisMethod(value) {
  if (typeof value === "string") return { description: value };
  const source = value && typeof value === "object" ? value : {};
  if (String(source.description || "").trim()) return { description: String(source.description) };
  // 将第二轮早期版本的五段式配置无损合并，旧技能打开后也只需编辑一个输入框。
  const legacySections = [
    ["分析目标", source.objective],
    ["关注重点", source.focus],
    ["判断规则", source.rules],
    ["输出要求", source.outputFormat],
    ["补充说明", source.notes]
  ].filter(([, content]) => String(content || "").trim());
  return { description: legacySections.map(([title, content]) => `${title}：${String(content).trim()}`).join("\n") };
}

function buildAnalysisPrompt(method) {
  return normalizeAnalysisMethod(method).description.trim();
}

function pageKey(url = location.href) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "");
  }
}

function normalizeHeader(value) {
  return compactOneLine(value).toLowerCase();
}

function tableCandidates() {
  const candidates = Array.from(document.querySelectorAll(TABLE_SELECTOR));
  return candidates.filter((candidate, index) => !candidates.some((parent, parentIndex) => (
    parentIndex !== index && parent.contains(candidate) && parent.matches(TABLE_SELECTOR)
  )));
}

function resolveTableFromTarget(target) {
  if (!(target instanceof Element)) return null;
  const row = target.closest("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const componentRoot = row ? getStableTableRoot(row) : null;
  if (componentRoot) return componentRoot;
  const matched = target.closest(TABLE_SELECTOR);
  if (!matched) return null;
  return tableCandidates().find((candidate) => candidate === matched || candidate.contains(matched)) || matched;
}

function cellTexts(cells) {
  return cells
    .map((cell) => compactOneLine(cell.innerText || cell.textContent || ""))
    .filter(Boolean)
    .slice(0, 80);
}

function alignedRowCellTexts(cells, expectedColumnCount) {
  const values = [];
  for (const cell of cells.slice(0, 80)) {
    values.push(compactOneLine(cell.innerText || cell.textContent || ""));
    // 合并单元格只占一个 DOM 节点，但后续单元格仍需保持原列位置。
    const span = Math.max(1, Number(cell.colSpan || cell.getAttribute?.("colspan")) || 1);
    for (let index = 1; index < span; index++) values.push("");
  }
  if (!expectedColumnCount) return values;
  // 很多数据组件在最左侧额外放置无标题的选择列。表头采集会忽略该空标题，
  // 因此只移除超出字段数的首尾空辅助列；业务列中间的空值必须原位保留。
  while (values.length > expectedColumnCount && values[0] === "") values.shift();
  while (values.length > expectedColumnCount && values.at(-1) === "") values.pop();
  if (values.length > expectedColumnCount) values.length = expectedColumnCount;
  while (values.length < expectedColumnCount) values.push("");
  return values;
}

function clickedHeaderCells(target) {
  if (!(target instanceof Element)) return [];
  const row = target.closest(
    "thead tr, [role='row'], .art-table-header-row, .ant-table-row, .arco-table-tr, " +
    "[class*='table-header'][class*='row'], [class*='table-head'][class*='row']"
  );
  if (!row) return [];
  const looksLikeHeader = isHeaderRow(row) || /(?:^|[-_\s])(header|thead|head)(?:[-_\s]|$)/i.test(row.className || "") || Boolean(row.closest("thead, [class*='table-header'], [class*='table-head']"));
  if (!looksLikeHeader) return [];
  return getRowCells(row);
}

function extractHeaders(table, preferredTarget = null) {
  if (!table) return [];
  // 优先读取完整表头区域。多级表头中，用户可能点击第一行的合并标题，
  // 但第二行仍包含实际细分列；绑定与刷新必须采用相同的完整集合。
  let cells = Array.from(table.querySelectorAll(
    "thead th, [role='columnheader'], th[scope='col'], " +
    ".art-table-header-cell, .ant-table-thead th, .arco-table-th, " +
    "[class*='table-header'] [class*='cell'], [class*='table-head'] [class*='cell']"
  ));
  // 非标准 div 表格无法标识完整表头区域时，再使用用户实际点击行兜底。
  if (!cells.length) cells = clickedHeaderCells(preferredTarget);
  // 复用 Chat 的表头关联算法，兼容固定表头与表体拆成兄弟 table 的组件。
  if (!cells.length) {
    const rows = Array.from(table.querySelectorAll("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"));
    const dataRow = rows.find((row) => !isHeaderRow(row) && getRowCells(row).length);
    const headerRow = dataRow ? findHeaderRowAbove(dataRow) : rows.find(isHeaderRow);
    if (headerRow) cells = getRowCells(headerRow);
  }
  if (!cells.length) {
    const firstRow = table.querySelector("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
    cells = firstRow ? Array.from(firstRow.querySelectorAll("th, td, [role='cell'], [role='gridcell'], .art-table-cell, .ant-table-cell, .arco-table-td")) : [];
  }
  return cellTexts(cells);
}

function describeTable(table, preferredTarget = null) {
  const candidates = tableCandidates();
  const headers = extractHeaders(table, preferredTarget);
  console.info("[web2ai.skill] selected table", {
    frame: IS_TOP_FRAME ? "top" : "child",
    root: `${table.tagName.toLowerCase()}${table.id ? `#${table.id}` : ""}.${String(table.className || "").split(/\s+/).slice(0, 3).join(".")}`,
    clicked: preferredTarget ? `${preferredTarget.tagName.toLowerCase()}.${String(preferredTarget.className || "").split(/\s+/).slice(0, 3).join(".")}` : "none",
    headerCount: headers.length,
    headers: headers.slice(0, 12)
  });
  return {
    selector: getCssSelector(table),
    tableIndex: Math.max(0, candidates.indexOf(table)),
    headers,
    headerFingerprint: headers.map(normalizeHeader).join("|"),
    preview: headers.join("、") || "未识别到数据源字段",
    frameUrl: pageKey(location.href),
    pageTitle: document.title,
    capturedAt: Date.now()
  };
}

function headerSimilarity(expected, actual) {
  const left = new Set((expected || []).map(normalizeHeader).filter(Boolean));
  const right = new Set((actual || []).map(normalizeHeader).filter(Boolean));
  // 旧数据源可能由早期版本保存且没有表头指纹。只要表格仍能定位，
  // 不应误报“数据源已变化”；重新绑定后会补齐新指纹。
  if (!left.size) return 1;
  if (!right.size) return 0;
  let overlap = 0;
  for (const header of left) if (right.has(header)) overlap++;
  // 数据源身份关注“绑定时的列是否仍存在”。页面新增派生列/费用明细列不会
  // 破坏已有分析方法，因此不应降低可用性；删除或重命名原列才降低覆盖率。
  return overlap / left.size;
}

function resolveStoredSource(source) {
  const candidates = tableCandidates();
  let selectorTable = null;
  let matchMethod = "none";
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  // 通用 DOM 路径在不同 frame 中可能恰好命中普通 div。只有能够归一化到
  // 当前 frame 的真实表格组件根节点时才接受，否则继续走序号/表头兜底。
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const ranked = candidates.map((table) => ({
    table,
    score: headerSimilarity(source?.headers || [], extractHeaders(table)),
    priority: table === selectorTable ? 2 : table === indexedTable ? 1 : 0,
    method: table === selectorTable ? "selector" : table === indexedTable ? "tableIndex" : "headerSimilarity"
  })).sort((a, b) => (b.score - a.score) || (b.priority - a.priority));
  const selectedMatch = source?.headers?.length
    ? ranked[0]
    : ranked.find((item) => item.table === selectorTable) || ranked.find((item) => item.table === indexedTable);
  const selected = selectedMatch?.table || null;
  matchMethod = selectedMatch?.method || "none";
  if (!selected) return { found: false, candidateCount: candidates.length, frameUrl: pageKey(location.href) };
  const headers = extractHeaders(selected);
  const similarity = headerSimilarity(source?.headers || [], headers);
  const diagnostic = {
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    selector: source?.selector || "",
    storedTableIndex: source?.tableIndex,
    candidateCount: candidates.length,
    matchMethod,
    expectedHeaderCount: source?.headers?.length || 0,
    expectedHeaders: (source?.headers || []).slice(0, 80),
    actualHeaderCount: headers.length,
    actualHeaders: headers.slice(0, 80),
    similarity,
    status: similarity >= 0.8 ? "available" : "changed"
  };
  // 单行 JSON 便于从复杂业务页面控制台直接复制；仅包含表头，不输出业务数据行。
  console.info("[web2ai.skill] validated source", JSON.stringify(diagnostic));
  return {
    found: true,
    status: similarity >= 0.8 ? "available" : "changed",
    headers,
    similarity
  };
}

function extractStoredSourceData(source, limit = 200) {
  const candidates = tableCandidates();
  let selectorTable = null;
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const ranked = candidates.map((table) => ({
    table,
    score: headerSimilarity(source?.headers || [], extractHeaders(table)),
    priority: table === selectorTable ? 2 : table === indexedTable ? 1 : 0
  })).sort((a, b) => (b.score - a.score) || (b.priority - a.priority));
  const selected = source?.headers?.length
    ? ranked[0]?.table
    : selectorTable || indexedTable;
  if (!selected) return { found: false, candidateCount: candidates.length };
  const headers = extractHeaders(selected);
  const allRows = Array.from(selected.querySelectorAll("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"))
    .filter((row) => !isHeaderRow(row))
    .map((row) => alignedRowCellTexts(getRowCells(row), headers.length))
    .filter((cells) => cells.length && cells.some(Boolean));
  const uniqueRows = [];
  const seen = new Set();
  for (const row of allRows) {
    const signature = row.join("\u241f");
    if (seen.has(signature)) continue;
    seen.add(signature);
    uniqueRows.push(row);
  }
  const rows = uniqueRows.slice(0, limit);
  return {
    found: true,
    status: headerSimilarity(source?.headers || [], headers) >= 0.8 ? "available" : "changed",
    headers,
    rows,
    rowCount: rows.length,
    totalRowCount: uniqueRows.length,
    truncated: uniqueRows.length > rows.length
  };
}

function inspectStoredSourcePagination(source) {
  const table = findStoredSourceTable(source);
  if (!table) return { found: false, multiPage: false };
  const anchorRow = table.querySelector?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const next = findPaginationNextButton(anchorRow);
  const pagination = next?.closest?.(".ant-pagination,.arco-pagination,[class*='pagination'],[role='navigation']");
  const pageNumbers = Array.from(pagination?.querySelectorAll?.("button,a,[role='button']") || [])
    .map((node) => Number.parseInt(compactOneLine(node.innerText || node.textContent || ""), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : 0;
  return { found: true, multiPage: Boolean(next || totalPages > 1), totalPages };
}

function emitCollectionProgress(collectionId, progress) {
  chrome.runtime.sendMessage({ type: "SKILL_COLLECTION_PROGRESS", collectionId, progress }).catch(() => void 0);
}

function logSkillCollection(event, details = {}) {
  if (!SKILL_COLLECTION_DIAGNOSTICS) return;
  console.info("[web2ai.skill-collection]", event, JSON.stringify({
    frame: IS_TOP_FRAME ? "top" : "child",
    ...details
  }));
}

function describeCollectionElement(node) {
  if (!node) return "none";
  const id = node.id ? `#${node.id}` : "";
  const classes = String(node.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 4).join(".");
  return `${node.tagName?.toLowerCase?.() || "element"}${id}${classes ? `.${classes}` : ""}`;
}

function findStoredSourceVerticalScroller(table) {
  if (!table) return null;
  const row = table.querySelector?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const candidates = new Set();
  const knownSelectors = [
    ".ant-table-body", ".ant-table-content", ".ant-virtual-list-holder",
    ".arco-table-body", ".arco-scrollbar-container", ".arco-virtual-list",
    ".art-table-body", ".art-virtual-scroll", "[class*='virtual-list']", "[class*='virtual-scroll']",
    "[role='rowgroup']"
  ].join(",");
  table.querySelectorAll?.(knownSelectors).forEach((node) => candidates.add(node));
  let ancestor = row || table;
  for (let depth = 0; depth < 20 && ancestor; depth++, ancestor = ancestor.parentElement) candidates.add(ancestor);
  // 一些嵌入式业务页面使用 iframe 文档本身驱动虚拟表格渲染，表格祖先没有 overflow。
  if (document.scrollingElement) candidates.add(document.scrollingElement);
  const ranked = [...candidates].filter((node) => {
    if (!(node instanceof HTMLElement) || !node.isConnected) return false;
    if (node !== document.scrollingElement && !isVisibleElement(node)) return false;
    return node.clientHeight >= 40 && node.scrollHeight - node.clientHeight > 8;
  }).map((node) => {
    const className = String(node.className || "");
    const style = getComputedStyle(node);
    const known = /(ant-table-body|virtual-list-holder|arco-table-body|arco-scrollbar-container|virtual-list|virtual-scroll|art-table-body)/i.test(className);
    const scrollStyle = /(auto|scroll)/.test(style.overflowY || "");
    const containsRow = Boolean(row && node.contains(row));
    const documentScroller = node === document.scrollingElement;
    return { node, score: (known ? 8 : 0) + (scrollStyle ? 4 : 0) + (containsRow ? 3 : 0) - (documentScroller ? 1 : 0) - Math.min(node.clientHeight / 1000, 2) };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.node || null;
}

function setVerticalScrollTop(scroller, top) {
  const next = Math.max(0, Math.min(Number(top) || 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
  scroller.scrollTop = next;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  return scroller.scrollTop;
}

function classifyVerticalCollection(scroller, table) {
  const className = `${String(scroller?.className || "")} ${String(table?.className || "")}`;
  const renderedRows = Array.from(table?.querySelectorAll?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr") || [])
    .filter((row) => !isHeaderRow(row));
  const layoutNodes = [table, table?.parentElement, ...renderedRows.slice(0, 3)].filter(Boolean);
  const hasVirtualLayoutEvidence = layoutNodes.some((node) => {
    const style = getComputedStyle(node);
    const inlineTransform = String(node.style?.transform || "");
    return style.position === "absolute" || /translate(?:3d|Y)?\s*\(/i.test(inlineTransform);
  }) || Number(table?.getAttribute?.("aria-rowcount") || 0) > renderedRows.length;
  return classifyScrollCollection({
    className,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    renderedRowHeights: renderedRows.map((row) => row.getBoundingClientRect?.().height || 0),
    isDocumentScroller: scroller === document.scrollingElement,
    hasVirtualLayoutEvidence
  });
}

async function waitForVirtualRows(source, beforeTable, beforeDigest, beforeRows) {
  await new Promise((resolve) => setTimeout(resolve, 140));
  const tableIndex = beforeTable?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(beforeTable) : -1;
  const changed = await waitForTableChange(beforeTable, beforeDigest, 2400, beforeRows, tableIndex);
  if (changed) await waitForTableDataReady(findLiveTableAfterPageTurn(beforeTable, tableIndex), beforeDigest, 3000, tableIndex);
}

async function collectStoredSourcePage(source, { collectionId, control, page, maxPages, maxRows, rows, seen }) {
  let headers = [];
  let added = 0;
  let scrollSteps = 0;
  const addRenderedRows = () => {
    const current = extractStoredSourceData(source, maxRows);
    if (!current.found) return current;
    headers = current.headers || headers;
    for (const row of current.rows || []) {
      const signature = row.join("\u241f");
      if (seen.has(signature)) continue;
      seen.add(signature);
      rows.push(row);
      added++;
      if (rows.length >= maxRows) break;
    }
    return current;
  };

  let current = addRenderedRows();
  if (!current.found) return { found: false, headers, added, scrollSteps };
  let table = findStoredSourceTable(source);
  let scroller = findStoredSourceVerticalScroller(table);
  const scrollMode = scroller ? classifyVerticalCollection(scroller, table) : "none";
  logSkillCollection("page scan", {
    collectionId, page, table: describeCollectionElement(table), scroller: describeCollectionElement(scroller),
    scrollMode, renderedRows: current.rowCount || 0, added, totalRows: rows.length,
    scrollTop: Math.round(scroller?.scrollTop || 0), clientHeight: scroller?.clientHeight || 0,
    scrollHeight: scroller?.scrollHeight || 0
  });
  if (scrollMode === "none") return { found: true, headers, added, scrollSteps };

  try {
    if (scroller.scrollTop > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, 0);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
    }

    let stableBottomPasses = 0;
    let consecutiveEmptySteps = 0;
    for (let step = 0; step < 160 && rows.length < maxRows && !control.stopped; step++) {
      table = findStoredSourceTable(source);
      scroller = findStoredSourceVerticalScroller(table) || scroller;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const currentTop = scroller.scrollTop;
      if (currentTop >= maxScrollTop - 2) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (expandedMax <= currentTop + 2) {
          stableBottomPasses++;
          if (stableBottomPasses >= 2) break;
          continue;
        }
      }
      stableBottomPasses = 0;
      const nextTop = nextVirtualScrollTop({
        scrollTop: currentTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      });
      if (nextTop <= currentTop + 1) break;
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      const actualTop = setVerticalScrollTop(scroller, nextTop);
      scrollSteps++;
      emitCollectionProgress(collectionId, {
        phase: "scrolling", page, pages: page - 1, rowCount: rows.length, scrollSteps,
        scrollTop: Math.round(actualTop), maxScrollTop: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
        maxPages, maxRows
      });
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      const addedBeforeScrollRead = added;
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
      const newlyAdded = added - addedBeforeScrollRead;
      consecutiveEmptySteps = newlyAdded > 0 ? 0 : consecutiveEmptySteps + 1;
      logSkillCollection("scroll step", {
        collectionId, page, step: scrollSteps, targetTop: Math.round(nextTop), actualTop: Math.round(scroller.scrollTop),
        clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        renderedRows: current.rowCount || 0, added: newlyAdded, consecutiveEmptySteps, totalRows: rows.length
      });
      const emptyStepLimit = scrollMode === "probe" ? 1 : 2;
      if (shouldStopAfterNoProgress(consecutiveEmptySteps, emptyStepLimit)) {
        logSkillCollection("page scroll stopped", {
          collectionId, page, reason: "no-new-rows", scrollSteps, consecutiveEmptySteps, totalRows: rows.length
        });
        break;
      }
    }
    logSkillCollection("page scroll complete", { collectionId, page, scrollSteps, added, totalRows: rows.length, stopped: control.stopped });
    return { found: true, headers, added, scrollSteps, stopped: control.stopped };
  } finally {
    table = findStoredSourceTable(source);
    scroller = findStoredSourceVerticalScroller(table) || scroller;
    if (scroller?.isConnected && scroller.scrollTop > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, 0);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows).catch(() => void 0);
      logSkillCollection("restore table top", { collectionId, page, success: scroller.scrollTop <= 1, scrollTop: Math.round(scroller.scrollTop) });
    }
  }
}

function findStoredSourcePagination(table) {
  let scope = table;
  for (let depth = 0; depth < 9 && scope; depth++, scope = scope.parentElement) {
    const candidates = Array.from(scope.querySelectorAll?.(".ant-pagination,.arco-pagination,[class*='pagination'],[role='navigation']") || []);
    const pagination = candidates.find((candidate) => {
      const text = compactOneLine(candidate.innerText || candidate.textContent || "");
      return /(^|\s)1(\s|$)/.test(text) || candidate.querySelector("[aria-current='page'],.ant-pagination-item-active,.arco-pagination-item-active");
    });
    if (pagination) return pagination;
  }
  return null;
}

function paginationIsOnFirstPage(pagination) {
  const active = pagination?.querySelector?.("[aria-current='page'],.ant-pagination-item-active,.arco-pagination-item-active");
  return compactOneLine(active?.innerText || active?.textContent || "") === "1";
}

async function clickPaginationAndWait(source, target) {
  const table = findStoredSourceTable(source);
  if (!table || !target) return false;
  const beforeRows = getTableRowTexts(table);
  const beforeDigest = getTableContentDigest(table);
  const tableIndex = table?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(table) : -1;
  if (!clickElement(target)) return false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const changed = await waitForTableChange(table, beforeDigest, 6000, beforeRows, tableIndex);
  if (!changed) return false;
  await waitForTableDataReady(findLiveTableAfterPageTurn(table, tableIndex), beforeDigest, 6000, tableIndex);
  return true;
}

async function restoreStoredSourceFirstPage(source) {
  let table = findStoredSourceTable(source);
  let pagination = findStoredSourcePagination(table);
  if (!pagination) {
    logSkillCollection("restore first page", { success: false, reason: "pagination-not-found" });
    return false;
  }
  if (paginationIsOnFirstPage(pagination)) {
    logSkillCollection("restore first page", { success: true, method: "already-first" });
    return true;
  }

  const pageOneContainer = Array.from(pagination.querySelectorAll("li,button,a,[role='button']"))
    .find((node) => compactOneLine(node.innerText || node.textContent || "") === "1");
  const pageOne = pageOneContainer?.matches?.("button,a,[role='button']")
    ? pageOneContainer
    : pageOneContainer?.querySelector?.("button,a,[role='button']") || pageOneContainer;
  if (pageOne && await clickPaginationAndWait(source, pageOne)) {
    table = findStoredSourceTable(source);
    pagination = findStoredSourcePagination(table);
    if (paginationIsOnFirstPage(pagination)) {
      logSkillCollection("restore first page", { success: true, method: "page-button" });
      return true;
    }
  }

  // 部分页码组件会折叠第一页，或只能通过“上一页”逐页返回。
  for (let attempt = 0; attempt < 20; attempt++) {
    table = findStoredSourceTable(source);
    pagination = findStoredSourcePagination(table);
    if (!pagination || paginationIsOnFirstPage(pagination)) return Boolean(pagination);
    const previous = pagination.querySelector(
      ".ant-pagination-prev button,.ant-pagination-prev a,.ant-pagination-prev .ant-pagination-item-link," +
      ".arco-pagination-item-previous button,.arco-pagination-prev button," +
      "button[aria-label*='上一页'],a[aria-label*='上一页'],button[aria-label*='previous' i],a[aria-label*='previous' i]"
    );
    const previousContainer = previous?.closest?.(".ant-pagination-prev,.arco-pagination-item-previous,.arco-pagination-prev");
    const disabled = !previous || previous.disabled || previous.getAttribute?.("aria-disabled") === "true" ||
      previousContainer?.classList?.contains("ant-pagination-disabled") ||
      previousContainer?.classList?.contains("arco-pagination-item-disabled");
    if (disabled || !await clickPaginationAndWait(source, previous)) break;
  }
  table = findStoredSourceTable(source);
  const restored = paginationIsOnFirstPage(findStoredSourcePagination(table));
  logSkillCollection("restore first page", { success: restored, method: "previous-buttons", reason: restored ? "" : "page-change-not-confirmed" });
  return restored;
}

async function collectStoredSourceData(source, options = {}) {
  const collectionId = String(options.collectionId || uid());
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages) || 10));
  const maxRows = Math.max(1, Math.min(2000, Number(options.maxRows) || 1000));
  const control = { stopped: false };
  activeCollections.set(collectionId, control);
  const rows = [];
  const seen = new Set();
  let headers = [];
  let pages = 0;
  let reason = "complete";
  let pageTurned = false;
  let restoredFirstPage = false;
  logSkillCollection("start", { collectionId, maxPages, maxRows });
  try {
    for (let page = 1; page <= maxPages; page++) {
      if (control.stopped) { reason = "stopped"; break; }
      logSkillCollection("page start", { collectionId, page, totalRows: rows.length });
      emitCollectionProgress(collectionId, { phase: "reading", page, pages, rowCount: rows.length, maxPages, maxRows });
      const currentPage = await collectStoredSourcePage(source, {
        collectionId, control, page, maxPages, maxRows, rows, seen
      });
      if (!currentPage.found) throw new Error("数据源定位失败");
      headers = currentPage.headers || headers;
      pages = page;
      emitCollectionProgress(collectionId, {
        phase: "page-complete", page, pages, rowCount: rows.length,
        added: currentPage.added, scrollSteps: currentPage.scrollSteps, maxPages, maxRows
      });
      logSkillCollection("page complete", {
        collectionId, page, added: currentPage.added, scrollSteps: currentPage.scrollSteps,
        totalRows: rows.length, stopped: control.stopped
      });
      if (control.stopped) { reason = "stopped"; break; }
      if (rows.length >= maxRows) { reason = "row-limit"; break; }
      if (page >= maxPages) { reason = "page-limit"; break; }
      const table = findStoredSourceTable(source);
      const anchorRow = table?.querySelector?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
      const next = findPaginationNextButton(anchorRow);
      const pagination = next?.closest?.(".ant-pagination,.arco-pagination,[class*='pagination'],[role='navigation']");
      const nextContainer = next?.closest?.(".ant-pagination-next,.arco-pagination-item-next,.arco-pagination-next");
      const disabled = !next || next.disabled || next.getAttribute?.("aria-disabled") === "true" ||
        nextContainer?.classList?.contains("ant-pagination-disabled") ||
        nextContainer?.classList?.contains("arco-pagination-item-disabled");
      logSkillCollection("pagination next", {
        collectionId, page, next: describeCollectionElement(next), pagination: describeCollectionElement(pagination), disabled
      });
      if (disabled) { reason = "last-page"; break; }
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      const tableIndex = table?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(table) : -1;
      emitCollectionProgress(collectionId, { phase: "turning", page, pages, rowCount: rows.length, maxPages, maxRows });
      if (!clickElement(next)) { reason = "next-click-failed"; break; }
      pageTurned = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (control.stopped) { reason = "stopped"; break; }
      const changed = await waitForTableChange(table, beforeDigest, 8000, beforeRows, tableIndex);
      if (!changed) {
        logSkillCollection("page turn", { collectionId, page, success: false, reason: "table-not-changed" });
        reason = "page-timeout";
        break;
      }
      const ready = await waitForTableDataReady(findLiveTableAfterPageTurn(table, tableIndex), beforeDigest, 8000, tableIndex);
      logSkillCollection("page turn", { collectionId, page, success: ready, reason: ready ? "" : "table-not-ready" });
      if (!ready) { reason = "page-timeout"; break; }
    }
    if (pageTurned) {
      emitCollectionProgress(collectionId, { phase: "restoring", pages, rowCount: rows.length, maxPages, maxRows });
      restoredFirstPage = await restoreStoredSourceFirstPage(source);
    }
    emitCollectionProgress(collectionId, { phase: "complete", pages, rowCount: rows.length, maxPages, maxRows, reason });
    logSkillCollection("complete", { collectionId, pages, rowCount: rows.length, uniqueSignatures: seen.size, reason, restoredFirstPage });
    return {
      found: true, status: "available", headers, rows, rowCount: rows.length,
      totalRowCount: rows.length, collectedPages: pages, collectionReason: reason,
      stopped: reason === "stopped", truncated: reason === "row-limit" || reason === "page-limit"
    };
  } finally {
    if (pageTurned && !restoredFirstPage) {
      emitCollectionProgress(collectionId, { phase: "restoring", pages, rowCount: rows.length, maxPages, maxRows });
      await restoreStoredSourceFirstPage(source).catch(() => false);
    }
    activeCollections.delete(collectionId);
  }
}

function stopStoredSourceCollection(collectionId) {
  const control = activeCollections.get(String(collectionId || ""));
  if (!control) return false;
  control.stopped = true;
  return true;
}

function findStoredSourceTable(source) {
  const candidates = tableCandidates();
  let selectorTable = null;
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  if (!source?.headers?.length) return selectorTable || indexedTable;
  return candidates.map((table) => ({
    table,
    score: headerSimilarity(source.headers, extractHeaders(table)),
    priority: table === selectorTable ? 2 : table === indexedTable ? 1 : 0
  })).sort((a, b) => (b.score - a.score) || (b.priority - a.priority))[0]?.table || null;
}

function focusStoredSource(source) {
  const table = findStoredSourceTable(source);
  if (!table) return { found: false, candidateCount: tableCandidates().length };
  const similarity = source?.headers?.length
    ? headerSimilarity(source.headers, extractHeaders(table))
    : 1;
  if (source?.headers?.length && similarity < 0.8) {
    return { found: false, candidateCount: tableCandidates().length, similarity };
  }
  const bar = table.previousElementSibling?.matches?.("[data-web2ai-skill-bar]")
    ? table.previousElementSibling
    : null;
  const target = bar || table;
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  const oldOutline = target.style.outline;
  const oldOutlineOffset = target.style.outlineOffset;
  target.style.outline = "3px solid #3b82f6";
  target.style.outlineOffset = "3px";
  setTimeout(() => {
    target.style.outline = oldOutline;
    target.style.outlineOffset = oldOutlineOffset;
  }, 1800);
  return { found: true, similarity };
}

function renderSkillBars(skills = []) {
  document.querySelectorAll("[data-web2ai-skill-bar]").forEach((node) => node.remove());
  const grouped = new Map();
  const probes = [];
  for (const skill of skills) {
    const expectedFrameUrl = pageKey(skill.source?.frameUrl || "");
    const table = findStoredSourceTable(skill.source);
    const similarity = table ? headerSimilarity(skill.source?.headers || [], extractHeaders(table)) : 0;
    const frameMatches = !expectedFrameUrl || expectedFrameUrl === pageKey(location.href);
    probes.push({
      skillId: skill.id,
      skillName: skill.name,
      expectedFrameUrl,
      frameMatches,
      foundTable: Boolean(table),
      similarity: Number(similarity.toFixed(3))
    });
    // frame 地址可能因站点路由、入口页或 iframe 重建而变化。横条与数据源
    // 可用性校验采用相同的 0.8 表头覆盖率，避免技能显示可用却不展示横条。
    if (!table || (!frameMatches && similarity < 0.8)) continue;
    const list = grouped.get(table) || [];
    list.push(skill);
    grouped.set(table, list);
  }
  for (const [table, tableSkills] of grouped) {
    const bar = document.createElement("div");
    bar.dataset.web2aiSkillBar = "1";
    bar.dataset.web2aiUi = "1";
    Object.assign(bar.style, {
      display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
      boxSizing: "border-box", width: "100%", margin: "0 0 8px", padding: "8px 10px",
      border: "1px solid #bfdbfe", borderRadius: "9px", background: "#eff6ff",
      color: "#1e3a8a", fontFamily: "system-ui,-apple-system,sans-serif", fontSize: "12px"
    });
    const label = document.createElement("span");
    label.textContent = "技能列表：";
    Object.assign(label.style, { fontWeight: "700", marginRight: "2px", whiteSpace: "nowrap" });
    bar.appendChild(label);
    for (const skill of tableSkills) {
      const item = document.createElement("span");
      Object.assign(item.style, {
        display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "100%",
        padding: "4px 5px 4px 8px", border: "1px solid #dbeafe", borderRadius: "8px", background: "#fff"
      });
      const name = document.createElement("span");
      name.textContent = skill.name;
      name.title = skill.name;
      Object.assign(name.style, { maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      const button = document.createElement("button");
      const canExecute = Boolean(buildAnalysisPrompt(skill.analysisMethod));
      button.textContent = "执行";
      button.disabled = !canExecute;
      button.title = canExecute ? `执行技能：${skill.name}` : "请先配置分析方法";
      Object.assign(button.style, {
        height: "24px", padding: "0 8px", border: "0", borderRadius: "7px",
        background: canExecute ? "#2563eb" : "#cbd5e1", color: "#fff", cursor: canExecute ? "pointer" : "not-allowed", fontSize: "11px"
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chrome.runtime.sendMessage({ type: "EXECUTE_SKILL_FROM_PAGE", skillId: skill.id }).catch(() => void 0);
      });
      item.append(name, button);
      bar.appendChild(item);
    }
    table.parentNode?.insertBefore(bar, table);
  }
  const diagnostic = JSON.stringify({
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    skillCount: skills.length,
    matchedSourceCount: grouped.size,
    barCount: document.querySelectorAll("[data-web2ai-skill-bar]").length,
    tableCandidateCount: tableCandidates().length,
    probes
  });
  const now = Date.now();
  const hasUnmatchedSkills = skills.length > 0 && grouped.size === 0;
  if (diagnostic !== lastSkillBarDiagnostic || (hasUnmatchedSkills && now - lastSkillBarDiagnosticAt >= 10000)) {
    lastSkillBarDiagnostic = diagnostic;
    lastSkillBarDiagnosticAt = now;
    if (hasUnmatchedSkills) {
      console.warn("[web2ai.skill-bar] sync", diagnostic);
    } else {
      console.info("[web2ai.skill-bar] sync", diagnostic);
    }
  }
}

function scheduleSkillBars(skills = []) {
  if (skillBarTimer) clearInterval(skillBarTimer);
  if (skillBarBroadcastTimer) clearInterval(skillBarBroadcastTimer);
  skillBarTimer = null;
  skillBarBroadcastTimer = null;
  renderSkillBars(skills);
  if (skills.length) {
    // 业务表可能在页面加载十几秒后才出现，也可能被 SPA/虚拟列表整体替换。
    // 低频重建只在当前页面存在技能时运行，确保横条最终出现并持续存在。
    skillBarTimer = setInterval(() => renderSkillBars(skills), 3000);
    if (IS_TOP_FRAME) {
      // 子 frame 的 main.js 通过动态 import 初始化，首次广播可能早于监听器注册。
      // 顶层低频重发，使延迟加载、重新导航或后创建的 iframe 最终都能收到技能列表。
      skillBarBroadcastTimer = setInterval(() => {
        chrome.runtime.sendMessage({
          type: "BROADCAST_TO_TAB",
          payload: { message: { type: "SYNC_SKILL_BARS", skills } }
        }).catch(() => void 0);
      }, 3000);
    }
  }
}

async function readSkills() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function writeSkills(skills) {
  await chrome.storage.local.set({ [STORAGE_KEY]: skills });
}

async function loadSkills() {
  if (!IS_TOP_FRAME) return;
  const [all, pageNamesData] = await Promise.all([
    readSkills(),
    chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY])
  ]);
  STATE.skillPageNames = pageNamesData[PAGE_NAMES_STORAGE_KEY] && typeof pageNamesData[PAGE_NAMES_STORAGE_KEY] === "object"
    ? pageNamesData[PAGE_NAMES_STORAGE_KEY]
    : {};
  STATE.skillCatalog = all;
  STATE.skills = all.filter((skill) => skill.pageKey === pageKey());
  STATE.skillSourceStatuses = Object.fromEntries(STATE.skills.map((skill) => [skill.id, { status: "checking" }]));
  renderCallback();
  scheduleSkillBars(STATE.skills);
  chrome.runtime.sendMessage({
    type: "BROADCAST_TO_TAB",
    payload: { message: { type: "SYNC_SKILL_BARS", skills: STATE.skills } }
  }).catch(() => void 0);
  await Promise.all(STATE.skills.map((skill) => validateSkillSource(skill)));
}

function createSkillDraft() {
  STATE.skillDraft = { id: "", name: "", sourceName: "", source: null, analysisMethod: emptyAnalysisMethod() };
  renderCallback();
}

function cancelSkillDraft() {
  STATE.skillDraft = null;
  renderCallback();
}

async function selectSkillTable() {
  if (!STATE.skillDraft) createSkillDraft();
  const sessionId = uid();
  STATE.skillPicking = true;
  STATE.skillPickSession = sessionId;
  STATE.open = false;
  renderCallback();
  await chrome.runtime.sendMessage({
    type: "BROADCAST_TO_TAB",
    payload: { message: { type: "START_SKILL_TABLE_PICK", sessionId } }
  });
}

async function startSkillCreation() {
  STATE.skillDraft = { id: "", name: "", sourceName: "", source: null, analysisMethod: emptyAnalysisMethod() };
  STATE.activePanelTab = "skills";
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
  await selectSkillTable();
}

function startSkillTablePickInFrame(sessionId) {
  if (!sessionId || activePickSession === sessionId) return;
  cancelActivePick?.();
  activePickSession = sessionId;
  let hovered = null;
  let hoveredTarget = null;
  let oldOutline = "";
  const hint = document.createElement("div");
  hint.dataset.web2aiUi = "skill-picker";
  hint.textContent = "移动到目标数据源并点击 · Esc 取消";
  Object.assign(hint.style, { position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "9px 15px", borderRadius: "999px", background: "#111827", color: "#fff", font: "13px system-ui", pointerEvents: "none" });
  document.documentElement.appendChild(hint);
  const restore = () => { if (hovered) hovered.style.outline = oldOutline; };
  const cleanup = () => {
    restore(); hint.remove();
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (activePickSession === sessionId) activePickSession = "";
    cancelActivePick = null;
  };
  const sendResult = (payload) => {
    cleanup();
    chrome.runtime.sendMessage({ type: "SKILL_TABLE_PICK_RESULT", payload: { sessionId, ...payload } }).catch(() => void 0);
  };
  const onMove = (event) => {
    if (event.target === hint || event.target?.closest?.("#web2ai_overlay_host")) return;
    const table = resolveTableFromTarget(event.target);
    hoveredTarget = event.target instanceof Element ? event.target : null;
    if (table === hovered) return;
    restore(); hovered = table; oldOutline = table?.style.outline || "";
    if (table) table.style.outline = "3px solid #2563eb";
  };
  const onDown = (event) => {
    if (event.button !== 0 || !hovered) return;
    event.preventDefault(); event.stopImmediatePropagation();
    sendResult({ source: describeTable(hovered, event.target instanceof Element ? event.target : hoveredTarget) });
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); sendResult({ cancelled: true });
  };
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  cancelActivePick = cleanup;
}

function cancelSkillTablePickInFrame(sessionId) {
  if (sessionId && activePickSession && sessionId !== activePickSession) return;
  cancelActivePick?.();
}

function acceptSkillTablePickResult(payload) {
  if (!IS_TOP_FRAME || !STATE.skillPicking || payload?.sessionId !== STATE.skillPickSession) return;
  STATE.skillPicking = false;
  STATE.skillPickSession = "";
  STATE.open = true;
  STATE.activePanelTab = "skills";
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
  refs.suppressPanelCloseUntil = Date.now() + 1000;
  if (refs.panelCloseTimer) clearTimeout(refs.panelCloseTimer);
  refs.panelCloseTimer = null;
  if (payload.cancelled) {
    showToast("已取消选择数据源");
  } else if (payload.source) {
    STATE.skillDraft ||= { id: "", name: "", sourceName: "", source: null, analysisMethod: emptyAnalysisMethod() };
    STATE.skillDraft.source = { ...payload.source, frameId: payload.frameId || 0, frameUrl: payload.frameUrl || payload.source.frameUrl };
    if (!STATE.skillDraft.sourceName) STATE.skillDraft.sourceName = payload.source.pageTitle || "页面数据源";
  }
  renderCallback();
}

async function saveSkillDraft() {
  const draft = STATE.skillDraft;
  if (!draft?.source) return showToast("请先选择数据源");
  if (!String(draft.name).trim()) return showToast("请填写技能名称");
  const all = await readSkills();
  const now = Date.now();
  const existing = all.find((skill) => skill.id === draft.id);
  const skill = {
    id: draft.id || uid(),
    version: 1,
    name: String(draft.name).trim(),
    pageKey: pageKey(),
    pageUrl: location.href,
    pageTitle: document.title,
    sourceName: String(draft.sourceName || draft.source?.pageTitle || document.title || "页面数据源").trim(),
    source: draft.source,
    analysisMethod: normalizeAnalysisMethod(draft.analysisMethod),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const index = all.findIndex((item) => item.id === skill.id);
  if (index >= 0) all[index] = skill; else all.unshift(skill);
  await writeSkills(all);
  STATE.skillDraft = null;
  showToast(existing ? "技能已修改" : "技能已保存");
}

async function saveSkillAnalysisMethod(id, description) {
  const all = await readSkills();
  const skill = all.find((item) => item.id === id);
  if (!skill) throw new Error("技能不存在或已被删除");
  skill.analysisMethod = normalizeAnalysisMethod({ description });
  skill.updatedAt = Date.now();
  await writeSkills(all);
  await loadSkills();
  return skill;
}

function rebindSkill(id) {
  const skill = STATE.skills.find((item) => item.id === id);
  if (!skill) return;
  STATE.skillDraft = {
    id: skill.id,
    name: skill.name,
    sourceName: skill.sourceName,
    source: skill.source,
    analysisMethod: normalizeAnalysisMethod(skill.analysisMethod)
  };
  renderCallback();
}

async function deleteSkill(id) {
  const all = await readSkills();
  await writeSkills(all.filter((skill) => skill.id !== id));
}

async function deleteAllSkills() {
  if (!STATE.skillCatalog.length) return;
  const accepted = await showConfirmDialog(`确定删除全部 ${STATE.skillCatalog.length} 个技能吗？此操作无法撤销。`);
  if (!accepted) return;
  STATE.skillDraft = null;
  STATE.skills = [];
  STATE.skillCatalog = [];
  STATE.skillSourceStatuses = {};
  STATE.skillPageNames = {};
  await chrome.storage.local.set({
    [STORAGE_KEY]: [],
    [PAGE_NAMES_STORAGE_KEY]: {}
  });
  renderCallback();
  showToast("全部技能已删除");
}

async function switchToSkillPage(targetPageKey, targetUrl, source = null) {
  let response = await chrome.runtime.sendMessage({
    type: "SWITCH_TO_SKILL_PAGE",
    pageKey: targetPageKey,
    pageUrl: targetUrl,
    source
  }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  if (!response?.ok && response?.code === "PAGE_NOT_OPEN") {
    const accepted = await showConfirmDialog("该技能页面当前没有保持打开，是否在当前标签页打开？");
    if (!accepted) return;
    response = await chrome.runtime.sendMessage({
      type: "SWITCH_TO_SKILL_PAGE",
      pageKey: targetPageKey,
      pageUrl: targetUrl,
      source,
      allowNavigateCurrentTab: true
    }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  }
  if (!response?.ok) {
    showToast(response?.error || "无法打开技能页面", 3200);
  }
}

async function renameCurrentSkillPage() {
  const currentPageKey = pageKey();
  const fallbackName = STATE.skills[0]?.pageTitle || document.title || currentPageKey;
  const currentName = STATE.skillPageNames[currentPageKey] || fallbackName;
  const value = await showPromptDialog("修改当前页面名称", currentName);
  if (value === null) return;
  const nextName = compactOneLine(value);
  if (!nextName) {
    showToast("页面名称不能为空");
    return;
  }
  const names = { ...STATE.skillPageNames, [currentPageKey]: nextName };
  STATE.skillPageNames = names;
  await chrome.storage.local.set({ [PAGE_NAMES_STORAGE_KEY]: names });
  renderCallback();
  showToast("页面名称已修改");
}

async function validateSkillSource(skill) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "VALIDATE_SKILL_SOURCE", source: skill.source });
    STATE.skillSourceStatuses[skill.id] = response?.data || { status: "missing" };
    if (!response?.data?.found) {
      console.info("[web2ai.skill] validation result", JSON.stringify({
        skillId: skill.id,
        skillName: skill.name,
        status: response?.data?.status || "missing",
        sourceFrameUrl: pageKey(skill.source?.frameUrl || ""),
        probes: response?.data?.probes || []
      }));
    }
  } catch {
    STATE.skillSourceStatuses[skill.id] = { status: "missing" };
  }
  renderCallback();
}

function initSkills(onRender) {
  renderCallback = onRender || renderCallback;
  if (IS_TOP_FRAME && !pageWatchTimer) {
    observedPageKey = pageKey();
    // SPA 的 pushState/replaceState 不会重新执行 content script，也没有统一事件。
    // 轮询规范化后的页面键可同时覆盖 history API、前进后退和站点自定义路由。
    pageWatchTimer = setInterval(() => {
      const currentPageKey = pageKey();
      if (currentPageKey === observedPageKey) return;
      observedPageKey = currentPageKey;
      STATE.skillDraft = null;
      STATE.skillSourceStatuses = {};
      loadSkills().catch(() => void 0);
    }, 400);
  }
  loadSkills().catch(() => void 0);
}

const reloadSkills = loadSkills;
export {
  initSkills, reloadSkills, createSkillDraft, cancelSkillDraft, selectSkillTable, startSkillCreation,
  startSkillTablePickInFrame, cancelSkillTablePickInFrame, acceptSkillTablePickResult,
  saveSkillDraft, rebindSkill, deleteSkill, deleteAllSkills, resolveStoredSource, switchToSkillPage,
  renameCurrentSkillPage, buildAnalysisPrompt,
  extractStoredSourceData, inspectStoredSourcePagination, collectStoredSourceData, stopStoredSourceCollection, focusStoredSource,
  saveSkillAnalysisMethod, scheduleSkillBars
};
