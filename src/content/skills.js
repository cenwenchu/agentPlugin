/**
 * @fileoverview 技能的数据源绑定、持久化、页面挂接与数据采集。
 *
 * 本模块运行在所有 frame：目标 frame 负责定位表格、分页及虚拟滚动采集；
 * top frame 负责技能目录、页面归属和状态汇总。模型调用与全屏交互位于 overlay.js。
 */

import { DEBUG, IS_TOP_FRAME, STATE, compactOneLine, refs, uid } from "./state.js";
import { getCssSelector, isVisibleElement } from "./dom.js";
import { showToast } from "./toast.js";
import { showConfirmDialog, showPromptDialog } from "./dialog.js";
import { MAX_SKILL_COLLECTION_PAGES, MAX_SKILL_COLLECTION_ROWS, classifyScrollCollection, nextVirtualScrollTop, shouldStopAfterNoProgress, skillHeadersMatch } from "./skill-collection-model.js";
import { skillContentFingerprint } from "./skill-import-model.js";
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
let skillValidationRunId = 0;
let lastSkillBarDiagnostic = "";
let lastSkillBarDiagnosticAt = 0;
let activeBusinessTabTitle = "";
let confirmedBusinessTabTitle = "";
let pendingBusinessTabTitle = "";
let businessTabClickListenerInstalled = false;
const activeCollections = new Map();
// 临时开启采集诊断，用于排查“分页 + 虚拟滚动 + 行回收”的真实站点。
// 只输出 DOM/滚动尺寸和行数，不输出单元格内容；问题定位后恢复为 DEBUG。
const SKILL_DIAGNOSTICS = DEBUG;
const SKILL_COLLECTION_DIAGNOSTICS = true;
const SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS = [400, 900, 1600, 2400];

function readBusinessPageTabs() {
  const titles = Array.from(document.querySelectorAll('[class*="realTab"]'))
    .filter((element) => String(element.className || "").split(/\s+/).some((name) => name.endsWith("-realTab")))
    .map((element) => compactOneLine(element.textContent || ""))
    .filter(Boolean);
  const uniqueTitles = [...new Set(titles)];
  return {
    titles: uniqueTitles,
    activeTitle: uniqueTitles.includes(confirmedBusinessTabTitle)
      ? confirmedBusinessTabTitle
      : uniqueTitles[uniqueTitles.length - 1] || "",
    activeTitleConfirmed: Boolean(confirmedBusinessTabTitle && uniqueTitles.includes(confirmedBusinessTabTitle))
  };
}

function getBusinessPageTabs() {
  return readBusinessPageTabs();
}

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
  // 组件重渲染时，相邻文本节点可能从“SKU信息 展示设置”变为
  // “SKU信息展示设置”。空白来自 DOM 布局而非字段语义，比较时应忽略。
  return compactOneLine(value).toLowerCase().replace(/\s+/g, "");
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

function inferTableTitle(table) {
  const direct = [
    table.querySelector("caption")?.textContent,
    table.getAttribute("aria-label"),
    table.getAttribute("data-title")
  ];
  for (let node = table, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const title = node.querySelector?.(
      ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [class*='card-title' i], " +
      ":scope > [class*='header-title' i], :scope > [class*='table-title' i], " +
      ":scope > * > [class*='card-title' i], :scope > * > [class*='header-title' i], :scope > * > [class*='table-title' i]"
    );
    if (title && !title.closest("thead, tr, [role='row']")) direct.push(title.textContent);
  }
  return direct.map(compactOneLine).find((value) => value && value.length <= 40) || "";
}

function describeTable(table, preferredTarget = null) {
  const candidates = tableCandidates();
  const headers = extractHeaders(table, preferredTarget);
  const tableTitle = inferTableTitle(table);
  const selector = getCssSelector(table);
  const tableIndex = Math.max(0, candidates.indexOf(table));
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill] selected table", {
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    root: `${table.tagName.toLowerCase()}${table.id ? `#${table.id}` : ""}.${String(table.className || "").split(/\s+/).slice(0, 3).join(".")}`,
    clicked: preferredTarget ? `${preferredTarget.tagName.toLowerCase()}.${String(preferredTarget.className || "").split(/\s+/).slice(0, 3).join(".")}` : "none",
    selector,
    tableIndex,
    candidateCount: candidates.length,
    headerCount: headers.length,
    headers: headers.slice(0, 12)
  });
  return {
    selector,
    tableIndex,
    headers,
    headerFingerprint: headers.map(normalizeHeader).join("|"),
    preview: headers.join("、") || "未识别到数据源字段",
    tableTitle,
    // 初次绑定优先记录明确的表格标题；业务 Tab 和字段兜底会在 top frame
    // 收到选择结果后补齐。保存后该名称不再自动重算。
    displayName: tableTitle,
    displayNameOrigin: "auto",
    isTopFrame: IS_TOP_FRAME,
    frameUrl: pageKey(location.href),
    capturedPageUrl: location.href,
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

function sourceMatchesCurrentFrame(source) {
  const expected = pageKey(source?.frameUrl || "");
  return !expected || expected === pageKey(location.href);
}

function resolveStoredSource(source) {
  if (!sourceMatchesCurrentFrame(source)) {
    return { found: false, candidateCount: 0, frameMismatch: true, frameUrl: pageKey(location.href) };
  }
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
  // 数据源身份必须由保存时的 DOM 定位确定。表头只负责校验变化，不能在
  // 多个相似表格之间替我们重新选择，否则订单/售后等同构表会互相串绑。
  const selected = selectorTable || indexedTable || null;
  matchMethod = selectorTable ? "selector" : indexedTable ? "tableIndex" : "none";
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
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed"
  };
  // 单行 JSON 便于从复杂业务页面控制台直接复制；仅包含表头，不输出业务数据行。
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill] validated source", JSON.stringify(diagnostic));
  return {
    found: true,
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed",
    headers,
    similarity
  };
}

function extractStoredSourceData(source, limit = 200) {
  if (!sourceMatchesCurrentFrame(source)) return { found: false, candidateCount: 0, frameMismatch: true };
  const candidates = tableCandidates();
  let selectorTable = null;
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const selected = selectorTable || indexedTable;
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
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed",
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
  SKILL_COLLECTION_DIAGNOSTICS && console.info("[web2ai.skill-collection]", event, JSON.stringify({
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

function describeScrollCandidates(table) {
  if (!table) return [];
  const nodes = new Set();
  table.querySelectorAll?.([
    ".ant-table-body", ".ant-table-content", ".ant-virtual-list-holder",
    ".arco-table-body", ".arco-scrollbar-container", ".arco-virtual-list",
    ".art-table-body", ".art-virtual-scroll", "[class*='virtual-list']", "[class*='virtual-scroll']",
    "[role='rowgroup']"
  ].join(",")).forEach((node) => nodes.add(node));
  let ancestor = table;
  for (let depth = 0; depth < 10 && ancestor; depth++, ancestor = ancestor.parentElement) nodes.add(ancestor);
  // 同源 iframe 可能随内容自动增高，自身没有滚动范围，真正的 viewport 在父页面。
  // 诊断与选择逻辑都要沿 frameElement 向上查看父文档滚动器。
  try {
    for (let currentWindow = window; currentWindow !== currentWindow.parent;) {
      const parentWindow = currentWindow.parent;
      if (parentWindow.document?.scrollingElement) nodes.add(parentWindow.document.scrollingElement);
      currentWindow = parentWindow;
    }
  } catch { /* 跨域父 frame 不能直接访问，保留当前 frame 候选。 */ }
  return [...nodes].filter((node) => node?.nodeType === 1).slice(0, 16).map((node) => ({
    element: describeCollectionElement(node),
    clientHeight: Math.round(node.clientHeight || 0),
    scrollHeight: Math.round(node.scrollHeight || 0),
    scrollTop: Math.round(node.scrollTop || 0),
    overflowY: node.ownerDocument?.defaultView?.getComputedStyle(node)?.overflowY || "",
    visible: isVisibleCollectionElement(node)
  }));
}

function isVisibleCollectionElement(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.ownerDocument === document) return isVisibleElement(node);
  const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
  const rect = node.getBoundingClientRect?.();
  return Boolean(style && rect && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") !== 0 && rect.width >= 2 && rect.height >= 2);
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
  try {
    for (let currentWindow = window; currentWindow !== currentWindow.parent;) {
      const parentWindow = currentWindow.parent;
      if (parentWindow.document?.scrollingElement) candidates.add(parentWindow.document.scrollingElement);
      currentWindow = parentWindow;
    }
  } catch { /* 跨域父 frame 由后续兼容层处理，当前版本不能直接驱动。 */ }
  const ranked = [...candidates].filter((node) => {
    if (node?.nodeType !== 1 || !node.isConnected) return false;
    if (node !== node.ownerDocument?.scrollingElement && !isVisibleCollectionElement(node)) return false;
    return node.clientHeight >= 40 && node.scrollHeight - node.clientHeight > 8;
  }).map((node) => {
    const className = String(node.className || "");
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    const known = /(ant-table-body|virtual-list-holder|arco-table-body|arco-scrollbar-container|virtual-list|virtual-scroll|art-table-body)/i.test(className);
    const scrollStyle = /(auto|scroll)/.test(style.overflowY || "");
    const containsRow = Boolean(row && node.contains(row));
    const documentScroller = node === node.ownerDocument?.scrollingElement;
    const ancestorFrameScroller = node.ownerDocument !== document;
    return { node, score: (known ? 8 : 0) + (scrollStyle ? 4 : 0) + (containsRow ? 3 : 0) + (ancestorFrameScroller ? 2 : 0) - (documentScroller ? 1 : 0) - Math.min(node.clientHeight / 1000, 2) };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.node || null;
}

function tableRectInDocument(table, targetDocument) {
  if (!table || !targetDocument) return null;
  let top = table.getBoundingClientRect().top;
  let height = table.getBoundingClientRect().height;
  try {
    for (let currentWindow = window; currentWindow.document !== targetDocument;) {
      const frame = currentWindow.frameElement;
      if (!frame || currentWindow === currentWindow.parent) return null;
      const frameRect = frame.getBoundingClientRect();
      top += frameRect.top;
      currentWindow = currentWindow.parent;
    }
  } catch { return null; }
  return { top, height };
}

function collectionScrollBounds(scroller, table) {
  const documentScroller = scroller === scroller?.ownerDocument?.scrollingElement;
  const isAncestorFrameScroller = scroller?.ownerDocument !== document;
  if (!documentScroller || !isAncestorFrameScroller) {
    return { start: 0, end: Math.max(0, scroller.scrollHeight - scroller.clientHeight), external: false };
  }
  const rect = tableRectInDocument(table, scroller.ownerDocument);
  if (!rect) return { start: scroller.scrollTop, end: Math.max(0, scroller.scrollHeight - scroller.clientHeight), external: true };
  const absoluteTop = scroller.scrollTop + rect.top;
  const maxDocumentTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const start = Math.max(0, Math.min(absoluteTop, maxDocumentTop));
  const end = Math.max(start, Math.min(absoluteTop + Math.max(0, rect.height - scroller.clientHeight), maxDocumentTop));
  return { start, end, external: true };
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
    // 当前 frame 的长文档必须有虚拟布局证据；同源父 frame 的滚动器则只在
    // 当前 frame 完全无滚动范围时才会被选中，先以 probe 行为验证是否产生新行。
    isDocumentScroller: scroller === document.scrollingElement,
    hasVirtualLayoutEvidence
  });
}

function tableHasVirtualLayoutEvidence(table) {
  if (!table) return false;
  const renderedRows = Array.from(table.querySelectorAll?.(
    "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"
  ) || []).filter((row) => !isHeaderRow(row));
  const layoutNodes = [table, table.parentElement, ...renderedRows.slice(0, 3)].filter(Boolean);
  const virtualCss = /(art-table|virtual-list|virtual-scroll|virtualized)/i.test(`${table.className || ""} ${table.parentElement?.className || ""}`);
  const hasTransform = layoutNodes.some((node) => {
    const style = getComputedStyle(node);
    const inlineTransform = String(node.style?.transform || "");
    return style.position === "absolute" || /translate(?:3d|Y)?\s*\(/i.test(inlineTransform);
  });
  const ariaRowCount = Number(table.getAttribute?.("aria-rowcount") || 0);
  return Boolean(virtualCss || hasTransform || (ariaRowCount > 0 && ariaRowCount > renderedRows.length));
}

function safeScrollIntoView(target, block = "start") {
  if (!(target instanceof Element)) return false;
  try {
    // Use the browser's built-in cross-frame scroll chaining; this is essential when the
    // child frame auto-expands and the real scroll container is in an ancestor document.
    target.scrollIntoView({ block, inline: "nearest" });
    return true;
  } catch {
    return false;
  }
}

async function waitForVirtualRows(source, beforeTable, beforeDigest, beforeRows) {
  await new Promise((resolve) => setTimeout(resolve, 140));
  const tableIndex = beforeTable?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(beforeTable) : -1;
  const changed = await waitForTableChange(beforeTable, beforeDigest, 2400, beforeRows, tableIndex);
  if (changed) await waitForTableDataReady(findLiveTableAfterPageTurn(beforeTable, tableIndex), beforeDigest, 3000, tableIndex);
}

async function resolvePageScrollCollection(source, initialTable, page) {
  let table = initialTable;
  let scroller = findStoredSourceVerticalScroller(table);
  let mode = scroller ? classifyVerticalCollection(scroller, table) : "none";
  // Some virtualized tables are driven by ancestor document scrolling (e.g. iframe auto height,
  // or custom wheel handlers) and expose no scrollHeight range in the current frame.
  // In that case, fall back to a conservative scrollIntoView-based collector.
  if (!scroller && tableHasVirtualLayoutEvidence(table)) mode = "into-view";
  // 分页切换完成不等于虚拟列表布局已完成。每一页都允许占位高度、
  // overflow 容器和首批行再经历几个渲染周期，否则后续页会被误判为
  // 普通表格并直接翻页。重试只读布局，不对普通表格产生滚动副作用。
  const attempts = 4;
  for (let attempt = 1; mode === "none" && attempt < attempts; attempt++) {
    logSkillCollection("scroll detection retry", {
      page,
      attempt,
      table: describeCollectionElement(table),
      scroller: describeCollectionElement(scroller),
      candidates: describeScrollCandidates(table)
    });
    await new Promise((resolve) => setTimeout(resolve, 140));
    table = findStoredSourceTable(source) || table;
    scroller = findStoredSourceVerticalScroller(table);
    mode = scroller ? classifyVerticalCollection(scroller, table) : (tableHasVirtualLayoutEvidence(table) ? "into-view" : "none");
  }
  logSkillCollection("scroll detection result", {
    page,
    mode,
    table: describeCollectionElement(table),
    scroller: describeCollectionElement(scroller),
    scrollTop: Math.round(scroller?.scrollTop || 0),
    clientHeight: Math.round(scroller?.clientHeight || 0),
    scrollHeight: Math.round(scroller?.scrollHeight || 0),
    candidates: describeScrollCandidates(table)
  });
  return { table, scroller, mode };
}

async function collectStoredSourcePage(source, { collectionId, control, page, maxPages, maxRows, rows, seen, waitForInitialRowsMs = 0 }) {
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

  // 分页与虚拟滚动叠加时，业务页可能保留上次的 scrollTop，或在换页后
  // 默认定位到中间。必须在第一次 addRenderedRows 之前回到顶部，否则被回收的
  // 顶部行永远不会进入 seen/rows，后续再复位也无法识别这个缺口。
  let table = findStoredSourceTable(source);
  let scroller = findStoredSourceVerticalScroller(table);
  let initialBounds = scroller ? collectionScrollBounds(scroller, table) : null;
  logSkillCollection("page prepare", {
    collectionId, page,
    table: describeCollectionElement(table),
    scroller: describeCollectionElement(scroller),
    scrollTop: Math.round(scroller?.scrollTop || 0),
    collectionStart: Math.round(initialBounds?.start || 0),
    collectionEnd: Math.round(initialBounds?.end || 0),
    externalScroller: Boolean(initialBounds?.external),
    clientHeight: Math.round(scroller?.clientHeight || 0),
    scrollHeight: Math.round(scroller?.scrollHeight || 0),
    candidates: describeScrollCandidates(table)
  });
  if (scroller?.isConnected) {
    if (Math.abs(scroller.scrollTop - initialBounds.start) > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, initialBounds.start);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      table = findStoredSourceTable(source) || table;
      scroller = findStoredSourceVerticalScroller(table) || scroller;
      logSkillCollection("prepare page top", {
        collectionId, page, success: Math.abs(scroller.scrollTop - initialBounds.start) <= 1,
        scrollTop: Math.round(scroller.scrollTop), targetTop: Math.round(initialBounds.start)
      });
    }
  } else if (table && tableHasVirtualLayoutEvidence(table)) {
    // No native scroll container was detected in this frame. Ensure the viewport is aligned to
    // the table start before reading rows; otherwise the virtual list may render from the middle.
    const beforeDigest = getTableContentDigest(table);
    const beforeRows = getTableRowTexts(table);
    safeScrollIntoView(table, "start");
    await waitForVirtualRows(source, table, beforeDigest, beforeRows);
    table = findStoredSourceTable(source) || table;
    logSkillCollection("prepare page top", {
      collectionId, page, method: "into-view",
      success: true,
      table: describeCollectionElement(table)
    });
  }

  let current = addRenderedRows();
  logSkillCollection("first rendered rows", {
    collectionId, page, found: Boolean(current.found), renderedRows: current.rowCount || 0,
    added, totalRows: rows.length, scrollTop: Math.round(scroller?.scrollTop || 0)
  });
  if (!current.found) return { found: false, headers, added, scrollSteps };
  if (page === 1 && !current.rowCount && waitForInitialRowsMs > 0) {
    const startedAt = Date.now();
    while (!control.stopped && Date.now() - startedAt < waitForInitialRowsMs) {
      emitCollectionProgress(collectionId, {
        phase: "waiting-rows", page, pages: 0, rowCount: rows.length, maxPages, maxRows
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
      if (current.rowCount > 0) break;
    }
    logSkillCollection("initial rows ready", {
      collectionId, page, waitedMs: Date.now() - startedAt, renderedRows: current.rowCount || 0
    });
  }
  const scrollCollection = await resolvePageScrollCollection(source, table, page);
  table = scrollCollection.table;
  scroller = scrollCollection.scroller;
  const scrollMode = scrollCollection.mode;
  // 等待期间首屏可能继续补行，先收录再开始滚动。
  current = addRenderedRows();
  if (!current.found) return { found: false, headers, added, scrollSteps };
  logSkillCollection("page scan", {
    collectionId, page, table: describeCollectionElement(table), scroller: describeCollectionElement(scroller),
    scrollMode, renderedRows: current.rowCount || 0, added, totalRows: rows.length,
    scrollTop: Math.round(scroller?.scrollTop || 0), clientHeight: scroller?.clientHeight || 0,
    scrollHeight: scroller?.scrollHeight || 0,
    candidates: page === 1 ? describeScrollCandidates(table) : undefined
  });
  if (scrollMode === "none") {
    logSkillCollection("page scroll skipped", {
      collectionId, page, reason: "no-scroll-mode", renderedRows: current.rowCount || 0,
      added, totalRows: rows.length, candidates: describeScrollCandidates(table)
    });
    return { found: true, headers, added, scrollSteps };
  }

  try {
    if (scrollMode === "into-view") {
      let consecutiveEmptySteps = 0;
      let stableBottomPasses = 0;
      for (let step = 0; step < 160 && rows.length < maxRows && !control.stopped; step++) {
        table = findStoredSourceTable(source) || table;
        const renderedRowEls = Array.from(table?.querySelectorAll?.(
          "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"
        ) || []).filter((row) => !isHeaderRow(row));
        const anchor = renderedRowEls.filter((row) => isVisibleCollectionElement(row)).at(-1) || renderedRowEls.at(-1) || table;
        const beforeDigest = getTableContentDigest(table);
        const beforeRows = getTableRowTexts(table);
        const scrolled = safeScrollIntoView(anchor, "end");
        scrollSteps++;
        emitCollectionProgress(collectionId, {
          phase: "scrolling", page, pages: page - 1, rowCount: rows.length, scrollSteps,
          maxPages, maxRows
        });
        if (!scrolled) break;
        await waitForVirtualRows(source, table, beforeDigest, beforeRows);
        const addedBefore = added;
        current = addRenderedRows();
        if (!current.found) return { found: false, headers, added, scrollSteps };
        const newlyAdded = added - addedBefore;
        consecutiveEmptySteps = newlyAdded > 0 ? 0 : consecutiveEmptySteps + 1;
        logSkillCollection("scroll step", {
          collectionId, page, step: scrollSteps, mode: "into-view",
          renderedRows: current.rowCount || 0, added: newlyAdded, consecutiveEmptySteps, totalRows: rows.length
        });
        if (newlyAdded <= 0) stableBottomPasses++;
        else stableBottomPasses = 0;
        if (stableBottomPasses >= 2 || shouldStopAfterNoProgress(consecutiveEmptySteps, 2)) break;
      }
      logSkillCollection("page scroll complete", { collectionId, page, scrollSteps, added, totalRows: rows.length, stopped: control.stopped, mode: "into-view" });
      return { found: true, headers, added, scrollSteps, stopped: control.stopped };
    }

    let bounds = collectionScrollBounds(scroller, table);
    if (Math.abs(scroller.scrollTop - bounds.start) > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, bounds.start);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
    }

    let stableBottomPasses = 0;
    let consecutiveEmptySteps = 0;
    let scrollingConfirmed = scrollMode === "confirmed";
    for (let step = 0; step < 160 && rows.length < maxRows && !control.stopped; step++) {
      table = findStoredSourceTable(source);
      scroller = findStoredSourceVerticalScroller(table) || scroller;
      bounds = collectionScrollBounds(scroller, table);
      const maxScrollTop = bounds.end;
      const currentTop = scroller.scrollTop;
      if (currentTop >= maxScrollTop - 2) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedMax = collectionScrollBounds(scroller, table).end;
        if (expandedMax <= currentTop + 2) {
          stableBottomPasses++;
          if (stableBottomPasses >= 2) break;
          continue;
        }
      }
      stableBottomPasses = 0;
      const nextTop = Math.min(maxScrollTop, nextVirtualScrollTop({
        scrollTop: currentTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      }));
      if (nextTop <= currentTop + 1) break;
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      const actualTop = setVerticalScrollTop(scroller, nextTop);
      scrollSteps++;
      emitCollectionProgress(collectionId, {
        phase: "scrolling", page, pages: page - 1, rowCount: rows.length, scrollSteps,
        scrollTop: Math.round(actualTop), maxScrollTop: Math.round(maxScrollTop),
        maxPages, maxRows
      });
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      const addedBeforeScrollRead = added;
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
      const newlyAdded = added - addedBeforeScrollRead;
      // `probe` 只表示初次缺少框架级虚拟滚动特征。一旦实际滚动获得了
      // 新数据，就已经用行为证明确实需要滚动；后续应容忍一个短暂空白
      // 区间，不能仍按“一次无新增即停止”的防误判规则提前结束。
      if (newlyAdded > 0) scrollingConfirmed = true;
      consecutiveEmptySteps = newlyAdded > 0 ? 0 : consecutiveEmptySteps + 1;
      logSkillCollection("scroll step", {
        collectionId, page, step: scrollSteps, targetTop: Math.round(nextTop), actualTop: Math.round(scroller.scrollTop),
        clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        renderedRows: current.rowCount || 0, added: newlyAdded, consecutiveEmptySteps, scrollingConfirmed, totalRows: rows.length
      });
      const emptyStepLimit = scrollingConfirmed ? 2 : 1;
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
    const restoreBounds = scroller?.isConnected ? collectionScrollBounds(scroller, table) : null;
    if (scroller?.isConnected && Math.abs(scroller.scrollTop - restoreBounds.start) > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, restoreBounds.start);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows).catch(() => void 0);
      logSkillCollection("restore table top", {
        collectionId, page, success: Math.abs(scroller.scrollTop - restoreBounds.start) <= 1,
        scrollTop: Math.round(scroller.scrollTop), targetTop: Math.round(restoreBounds.start)
      });
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

async function restoreStoredSourceTableTop(source, reason = "restore") {
  const table = findStoredSourceTable(source);
  const scroller = findStoredSourceVerticalScroller(table);
  if (!scroller?.isConnected) return true;
  const bounds = collectionScrollBounds(scroller, table);
  if (Math.abs(scroller.scrollTop - bounds.start) <= 1) return true;
  const beforeDigest = getTableContentDigest(table);
  const beforeRows = getTableRowTexts(table);
  setVerticalScrollTop(scroller, bounds.start);
  await waitForVirtualRows(source, table, beforeDigest, beforeRows).catch(() => void 0);
  const liveTable = findStoredSourceTable(source) || table;
  const liveScroller = findStoredSourceVerticalScroller(liveTable) || scroller;
  const liveBounds = collectionScrollBounds(liveScroller, liveTable);
  const success = Math.abs(liveScroller.scrollTop - liveBounds.start) <= 1;
  logSkillCollection("restore table top", {
    reason, success, scrollTop: Math.round(liveScroller.scrollTop), targetTop: Math.round(liveBounds.start)
  });
  return success;
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
    await restoreStoredSourceTableTop(source, "already-first-page");
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
      await restoreStoredSourceTableTop(source, "page-one-button");
      logSkillCollection("restore first page", { success: true, method: "page-button" });
      return true;
    }
  }

  // 部分页码组件会折叠第一页，或只能通过“上一页”逐页返回。
  for (let attempt = 0; attempt < 20; attempt++) {
    table = findStoredSourceTable(source);
    pagination = findStoredSourcePagination(table);
    if (!pagination || paginationIsOnFirstPage(pagination)) {
      if (pagination) await restoreStoredSourceTableTop(source, "previous-buttons");
      return Boolean(pagination);
    }
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
  if (restored) await restoreStoredSourceTableTop(source, "previous-buttons-complete");
  logSkillCollection("restore first page", { success: restored, method: "previous-buttons", reason: restored ? "" : "page-change-not-confirmed" });
  return restored;
}

async function collectStoredSourceData(source, options = {}) {
  const collectionId = String(options.collectionId || uid());
  const maxPages = Math.max(1, Math.min(MAX_SKILL_COLLECTION_PAGES, Number(options.maxPages) || 1));
  const maxRows = Math.max(1, Math.min(MAX_SKILL_COLLECTION_ROWS, Number(options.maxRows) || MAX_SKILL_COLLECTION_ROWS));
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
        collectionId, control, page, maxPages, maxRows, rows, seen,
        waitForInitialRowsMs: Number(options.waitForInitialRowsMs) || 0
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
      const turnedTable = findStoredSourceTable(source);
      logSkillCollection("page turn", {
        collectionId, page, success: ready, reason: ready ? "" : "table-not-ready",
        nextTable: describeCollectionElement(turnedTable),
        candidates: describeScrollCandidates(turnedTable)
      });
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
  if (!sourceMatchesCurrentFrame(source)) return null;
  const candidates = tableCandidates();
  let selectorTable = null;
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  return selectorTable || indexedTable;
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
    for (const source of (Array.isArray(skill.pageSources) ? skill.pageSources : skillSources(skill))) {
      const expectedFrameUrl = pageKey(source.frameUrl || "");
      const table = findStoredSourceTable(source);
      const similarity = table ? headerSimilarity(source.headers || [], extractHeaders(table)) : 0;
      const frameMatches = !expectedFrameUrl || expectedFrameUrl === pageKey(location.href);
      probes.push({
        skillId: skill.id,
        skillName: skill.name,
        sourceId: source.id,
        expectedFrameUrl,
        frameMatches,
        foundTable: Boolean(table),
        similarity: Number(similarity.toFixed(3))
      });
      if (!table || !frameMatches) continue;
      const list = grouped.get(table) || [];
      if (!list.some((item) => item.id === skill.id)) list.push(skill);
      grouped.set(table, list);
    }
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
      SKILL_DIAGNOSTICS && console.warn("[web2ai.skill-bar] sync", diagnostic);
    } else {
      SKILL_DIAGNOSTICS && console.info("[web2ai.skill-bar] sync", diagnostic);
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
  const stored = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  // 读取时只做结构兼容，绝不回写或重新生成已经保存的数据源名称。
  return stored.map(normalizeStoredSkill);
}

async function writeSkills(skills) {
  await chrome.storage.local.set({ [STORAGE_KEY]: skills });
}

async function downloadSkillsExport() {
  const [skills, pageNamesData] = await Promise.all([
    readSkills(),
    chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY])
  ]);
  const payload = {
    format: "web2ai-skills",
    version: 1,
    exportedAt: new Date().toISOString(),
    skills,
    pageNames: pageNamesData[PAGE_NAMES_STORAGE_KEY] || {}
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `web2ai-skills-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return skills.length;
}

async function previewSkillsImport(text) {
  if (String(text || "").length > 5 * 1024 * 1024) throw new Error("导入文件不能超过 5MB");
  let parsed;
  try { parsed = JSON.parse(String(text || "")); } catch { throw new Error("文件不是有效的 JSON"); }
  const rawSkills = Array.isArray(parsed) ? parsed : parsed?.skills;
  if (!Array.isArray(rawSkills) || !rawSkills.length) throw new Error("文件中没有可导入的技能");
  if (rawSkills.length > 500) throw new Error("一次最多导入 500 个技能");
  const existing = await readSkills();
  const seenFingerprints = new Set(existing.map(skillContentFingerprint));
  const imported = [];
  const failures = [];
  let duplicate = 0;
  rawSkills.forEach((raw, skillIndex) => {
    try {
      const normalized = normalizeStoredSkill(raw);
      const name = compactOneLine(normalized?.name);
      const sources = skillSources(normalized);
      if (!name) throw new Error("缺少技能名称");
      if (!sources.length) throw new Error("没有数据源");
      for (const source of sources) {
        if (!source.pageKey || !Array.isArray(source.headers) || !source.headers.length || (!source.selector && !Number.isInteger(source.tableIndex))) {
          throw new Error("包含无效的数据源绑定");
        }
      }
      const candidate = { ...normalized, name, sources, source: sources[0] };
      const fingerprint = skillContentFingerprint(candidate);
      if (seenFingerprints.has(fingerprint)) {
        duplicate++;
        return;
      }
      seenFingerprints.add(fingerprint);
      const id = uid();
      const importedSources = sources.map((source, sourceIndex) => ({
        ...source,
        id: `source_${id}_${sourceIndex + 1}`
      }));
      imported.push({
        ...candidate,
        id,
        sources: importedSources,
        source: importedSources[0],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    } catch (error) {
      failures.push({
        index: skillIndex + 1,
        name: compactOneLine(raw?.name) || `第 ${skillIndex + 1} 个技能`,
        error: String(error?.message ?? error)
      });
    }
  });
  const pageNames = parsed?.pageNames && typeof parsed.pageNames === "object" && !Array.isArray(parsed.pageNames)
    ? Object.fromEntries(Object.entries(parsed.pageNames).filter(([key, value]) => key && typeof value === "string"))
    : {};
  return {
    skills: imported,
    pageNames,
    total: rawSkills.length,
    success: imported.length,
    duplicate,
    failed: failures.length,
    failures
  };
}

async function applySkillsImport(preview) {
  const existing = await readSkills();
  const merged = [...existing, ...preview.skills];
  const pageNamesData = await chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY]);
  await Promise.all([
    writeSkills(merged),
    chrome.storage.local.set({
      [PAGE_NAMES_STORAGE_KEY]: { ...(pageNamesData[PAGE_NAMES_STORAGE_KEY] || {}), ...(preview.pageNames || {}) }
    })
  ]);
  await loadSkills();
  await chrome.runtime.sendMessage({ type: "REFRESH_SKILLS_ALL_TABS" }).catch(() => void 0);
  return { total: preview.total, success: preview.success, duplicate: preview.duplicate, failed: preview.failed };
}

function autoSourceDisplayName(source, index = 0) {
  const direct = compactOneLine(source.tableTitle || source.businessTabTitle || "");
  if (direct) return direct;
  const ignored = /^(序号|操作|选择|全选|checkbox)$/i;
  const representativeHeaders = (source.headers || []).map(compactOneLine).filter((header) => header && !ignored.test(header)).slice(0, 2);
  if (representativeHeaders.length) return `${representativeHeaders.join("、")}${representativeHeaders.length > 1 ? "等数据" : "数据"}`;
  return `数据源 ${index + 1}`;
}

function normalizeSkillSource(source, index = 0) {
  if (!source || typeof source !== "object") return null;
  const frameId = Number(source.frameId) || 0;
  const normalizedFrameUrl = pageKey(source.frameUrl || "");
  // 非历史迁移数据中，顶层 frame 的地址必然就是数据源所属页面。
  // 这也会在加载时自动修复曾因 tab.url 与 sender.url 不同步而保存错页的数据源。
  const repairTopFrameOwnership = frameId === 0 && !source.legacyPageOwnership && /^https?:\/\//.test(normalizedFrameUrl);
  const sourcePageUrl = repairTopFrameOwnership ? (source.frameUrl || normalizedFrameUrl) : (source.pageUrl || source.frameUrl || "");
  const storedDisplayName = compactOneLine(source.displayName || source.sourceName || source.pageTitle || "");
  // 名称是绑定时的用户可见快照。只在首次绑定且完全没有历史名称时生成，
  // 页面标题、业务 Tab 或表头后续变化都不能隐式改名。
  const hasStoredDisplayName = Boolean(storedDisplayName);
  return {
    ...source,
    frameId,
    id: source.id || uid(),
    displayName: hasStoredDisplayName ? storedDisplayName : autoSourceDisplayName(source, index),
    displayNameCustomized: source.displayNameCustomized === true,
    displayNameOrigin: source.displayNameOrigin || (hasStoredDisplayName ? "recorded" : "auto"),
    pageKey: repairTopFrameOwnership ? normalizedFrameUrl : (source.pageKey || pageKey(sourcePageUrl)),
    pageUrl: sourcePageUrl
  };
}

function skillSources(skill) {
  const values = Array.isArray(skill?.sources) && skill.sources.length ? skill.sources : (skill?.source ? [skill.source] : []);
  return values.map((source, index) => normalizeSkillSource({
    ...source,
    id: source?.id || (skill?.id ? `source_${skill.id}_${index + 1}` : "")
  }, index)).filter(Boolean);
}

function normalizeStoredSkill(skill) {
  if (!skill || typeof skill !== "object") return skill;
  const sources = skillSources(skill).map((source, index) => {
    const migrationId = skill.id ? `source_${skill.id}_${index + 1}` : "";
    // 修复上一版从旧 `source` 推导 pageKey 时误用了 frameUrl 的记录。
    // 迁移生成的稳定 ID 只代表历史数据源，原始归属必须以 skill.pageKey 为准。
    if (source.id === migrationId) {
      return { ...source, pageKey: skill.pageKey || source.pageKey, pageUrl: skill.pageUrl || source.pageUrl, legacyPageOwnership: true };
    }
    return source;
  });
  const primarySource = sources[0] || null;
  const sourcePageKeys = new Set(sources.map((source) => source.pageKey).filter(Boolean));
  // 独立编辑器早期版本曾把“创建入口页”误存为技能主页面。
  // 当主页面不属于任何数据源时，可确定为错归属并安全迁移到第一个数据源页面。
  const repairPrimaryPage = Boolean(primarySource?.pageKey && !sourcePageKeys.has(skill.pageKey));
  return {
    ...skill,
    version: Math.max(3, Number(skill.version) || 1),
    pageKey: repairPrimaryPage ? primarySource.pageKey : skill.pageKey,
    pageUrl: repairPrimaryPage ? (primarySource.pageUrl || skill.pageUrl) : skill.pageUrl,
    pageTitle: repairPrimaryPage ? (primarySource.pageTitle || skill.pageTitle) : skill.pageTitle,
    sourceName: primarySource?.displayName || skill.sourceName,
    sources,
    source: primarySource
  };
}

async function loadSkills() {
  if (!IS_TOP_FRAME) return;
  const validationRunId = ++skillValidationRunId;
  const [all, pageNamesData] = await Promise.all([
    readSkills(),
    chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY])
  ]);
  const businessTabs = readBusinessPageTabs();
  activeBusinessTabTitle = businessTabs.activeTitle;
  const currentPageKey = pageKey();
  let learnedTabTitle = false;
  if (activeBusinessTabTitle) {
    for (const skill of all) {
      for (const source of skill.sources) {
        const shouldRepairTabTitle = businessTabs.activeTitleConfirmed && source.businessTabTitle !== activeBusinessTabTitle;
        if (source.pageKey === currentPageKey && (!source.businessTabTitle || shouldRepairTabTitle)) {
          source.businessTabTitle = activeBusinessTabTitle;
          source.businessTabTitleConfirmed = businessTabs.activeTitleConfirmed;
          learnedTabTitle = true;
        }
      }
      skill.source = skill.sources[0] || null;
    }
  }
  if (learnedTabTitle) await writeSkills(all);
  STATE.skillPageNames = pageNamesData[PAGE_NAMES_STORAGE_KEY] && typeof pageNamesData[PAGE_NAMES_STORAGE_KEY] === "object"
    ? pageNamesData[PAGE_NAMES_STORAGE_KEY]
    : {};
  STATE.skillCatalog = all;
  STATE.skills = all.filter((skill) => skill.pageKey === currentPageKey || skill.sources.some((source) => source.pageKey === currentPageKey))
    .map((skill) => ({
      ...skill,
      // 横条渲染只能看到当前顶层页面的数据源，不能拿其他页面的相似表格兜底。
      pageSources: skill.sources.filter((source) => source.pageKey === currentPageKey || (!source.pageKey && skill.pageKey === currentPageKey))
    }));
  STATE.skillSourceStatuses = Object.fromEntries(STATE.skills.map((skill) => [
    skill.id,
    Object.fromEntries(skill.sources.map((source) => [source.id, { status: "checking" }]))
  ]));
  renderCallback();
  scheduleSkillBars(STATE.skills);
  chrome.runtime.sendMessage({
    type: "BROADCAST_TO_TAB",
    payload: { message: { type: "SYNC_SKILL_BARS", skills: STATE.skills } }
  }).catch(() => void 0);
  await Promise.all(STATE.skills.map((skill) => validateSkillSource(skill, validationRunId)));
}

function createSkillDraft() {
  STATE.skillDraft = { id: "", name: "", sources: [], analysisMethod: emptyAnalysisMethod() };
  STATE.activePanelTab = "skills";
  STATE.open = true;
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
  renderCallback();
}

function cancelSkillDraft() {
  STATE.skillDraft = null;
  renderCallback();
}

async function selectSkillTable(sourceId = "") {
  if (!STATE.skillDraft) STATE.skillDraft = { id: "", name: "", sources: [], analysisMethod: emptyAnalysisMethod() };
  const sessionId = uid();
  STATE.skillPicking = true;
  STATE.skillPickSession = sessionId;
  STATE.skillPickSourceId = sourceId;
  STATE.open = false;
  renderCallback();
  await chrome.runtime.sendMessage({
    type: "START_SKILL_SOURCE_PICK",
    sessionId
  });
}

async function startSkillCreation() {
  createSkillDraft();
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
    if (event.button !== 0) return;
    const clickedTable = hovered || resolveTableFromTarget(event.target);
    if (!clickedTable) {
      const target = event.target instanceof Element ? event.target : null;
      const drawer = target?.closest?.(".ant-drawer,.ant-modal,.arco-drawer,.arco-modal,[role='dialog'],[class*='drawer' i],[class*='modal' i]");
      SKILL_DIAGNOSTICS && console.info("[web2ai.skill-pick] unresolved click", JSON.stringify({
        frame: IS_TOP_FRAME ? "top" : "child",
        frameUrl: pageKey(location.href),
        target: target ? `${target.tagName.toLowerCase()}#${target.id || ""}.${String(target.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 5).join(".")}` : "none",
        inDrawer: Boolean(drawer),
        drawer: drawer ? `${drawer.tagName.toLowerCase()}#${drawer.id || ""}.${String(drawer.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 5).join(".")}` : "none",
        candidateCount: tableCandidates().length
      }));
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    sendResult({ source: describeTable(clickedTable, event.target instanceof Element ? event.target : hoveredTarget) });
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
    STATE.skillDraft ||= { id: "", name: "", sources: [], analysisMethod: emptyAnalysisMethod() };
    const selectedSource = {
      ...payload.source,
      id: STATE.skillPickSourceId || uid(),
      frameId: payload.frameId || 0,
      frameUrl: payload.frameUrl || payload.source.frameUrl,
      pageKey: payload.pageKey || payload.source.pageKey,
      pageUrl: payload.pageUrl || payload.source.pageUrl
    };
    if (!compactOneLine(selectedSource.displayName || "")) {
      selectedSource.displayName = autoSourceDisplayName(selectedSource, STATE.skillDraft.sources.length);
      selectedSource.displayNameOrigin = "auto";
    }
    const source = normalizeSkillSource(selectedSource, STATE.skillDraft.sources.length);
    // “添加数据源”和用户主动“重新选择”走同一套快照逻辑：名称、页面
    // 展示信息和表头都以本次明确选择为准。日常读取与校验仍不会自动改名。
    if (!source.displayNameCustomized) {
      const baseName = source.displayName;
      const sameNameCount = STATE.skillDraft.sources.filter((item) => (
        item.id !== STATE.skillPickSourceId &&
        (item.displayName === baseName || item.displayName?.startsWith(`${baseName}（`))
      )).length;
      if (sameNameCount) source.displayName = `${baseName}（${sameNameCount + 1}）`;
    }
    const duplicateIndex = STATE.skillDraft.sources.findIndex((item) => (
      item.id !== STATE.skillPickSourceId && item.pageKey === source.pageKey &&
      item.frameUrl === source.frameUrl && item.selector === source.selector &&
      Number(item.tableIndex) === Number(source.tableIndex)
    ));
    if (duplicateIndex >= 0) {
      SKILL_DIAGNOSTICS && console.info("[web2ai.skill-pick] duplicate source", JSON.stringify({
        existingSourceId: STATE.skillDraft.sources[duplicateIndex].id,
        selectedSourceId: source.id,
        pageKey: source.pageKey,
        frameUrl: source.frameUrl,
        selector: source.selector,
        tableIndex: source.tableIndex
      }));
      showToast("该数据源已经添加");
    } else if (STATE.skillPickSourceId) {
      const index = STATE.skillDraft.sources.findIndex((item) => item.id === STATE.skillPickSourceId);
      if (index >= 0) STATE.skillDraft.sources[index] = source;
    } else {
      STATE.skillDraft.sources.push(source);
    }
  }
  STATE.skillPickSourceId = "";
  renderCallback();
}

function removeSkillDraftSource(sourceId) {
  if (!STATE.skillDraft) return;
  STATE.skillDraft.sources = STATE.skillDraft.sources.filter((source) => source.id !== sourceId);
  renderCallback();
}

async function saveSkillDraft() {
  const draft = STATE.skillDraft;
  if (!draft?.sources?.length) return showToast("请至少选择一个数据源");
  if (!String(draft.name).trim()) return showToast("请填写技能名称");
  const all = await readSkills();
  const now = Date.now();
  const existing = all.find((skill) => skill.id === draft.id);
  const primarySource = normalizeSkillSource(draft.sources[0]);
  const skill = {
    id: draft.id || uid(),
    version: 3,
    name: String(draft.name).trim(),
    // 创建/修改期间可能跨多个页面选表，技能主归属始终跟随第一个数据源。
    pageKey: primarySource.pageKey || existing?.pageKey || pageKey(),
    pageUrl: primarySource.pageUrl || existing?.pageUrl || location.href,
    pageTitle: primarySource.pageTitle || existing?.pageTitle || document.title,
    sourceName: primarySource.displayName,
    sources: draft.sources.map(normalizeSkillSource),
    source: primarySource,
    analysisMethod: normalizeAnalysisMethod(draft.analysisMethod),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const index = all.findIndex((item) => item.id === skill.id);
  if (index >= 0) all[index] = skill; else all.unshift(skill);
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill] saved skill", JSON.stringify({
    skillId: skill.id,
    skillName: skill.name,
    primaryPageKey: skill.pageKey,
    sourceCount: skill.sources.length,
    sources: skill.sources.map((source) => ({
      sourceId: source.id,
      pageKey: source.pageKey,
      frameId: source.frameId,
      frameUrl: source.frameUrl,
      selector: source.selector,
      tableIndex: source.tableIndex,
      headerCount: source.headers?.length || 0
    }))
  }));
  await writeSkills(all);
  STATE.skillDraft = null;
  STATE.open = true;
  STATE.activePanelTab = "skills";
  await loadSkills();
  await chrome.runtime.sendMessage({ type: "REFRESH_SKILLS_ALL_TABS" }).catch(() => void 0);
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

async function updateSkillSourceHeaders(skillId, sourceId, headers) {
  const normalizedHeaders = Array.isArray(headers) ? headers.map((header) => compactOneLine(header)).filter(Boolean) : [];
  if (!normalizedHeaders.length) throw new Error("未识别到新的数据源字段");
  const all = await readSkills();
  const skill = all.find((item) => item.id === skillId);
  const source = skill?.sources?.find((item) => item.id === sourceId);
  if (!skill || !source) throw new Error("未找到需要更新的数据源");
  source.headers = normalizedHeaders;
  source.capturedAt = Date.now();
  skill.source = skill.sources[0] || null;
  skill.updatedAt = Date.now();
  await writeSkills(all);
  await loadSkills();
  return source;
}

function rebindSkill(id) {
  const skill = STATE.skillCatalog.find((item) => item.id === id);
  if (!skill) return;
  STATE.skillDraft = {
    id: skill.id,
    name: skill.name,
    sources: skillSources(skill),
    analysisMethod: normalizeAnalysisMethod(skill.analysisMethod),
    createdAt: skill.createdAt || 0
  };
  STATE.activePanelTab = "skills";
  STATE.open = true;
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
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

async function validateSkillSource(skill, validationRunId = skillValidationRunId) {
  const statuses = {};
  await Promise.all(skill.sources.map(async (source) => {
    if (source.pageKey !== pageKey()) {
      statuses[source.id] = { status: "deferred", found: false };
      return;
    }
    try {
      let validated = null;
      for (let attempt = 0; attempt <= SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS.length; attempt++) {
        const response = await chrome.runtime.sendMessage({ type: "VALIDATE_SKILL_SOURCE", source });
        validated = response?.data || { status: "missing" };
        // 站点慢加载时，首轮常出现“表格尚未挂载”；给一个短暂重试窗口避免误报失效。
        if (validated.found || validated.status === "changed") break;
        if (attempt >= SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS.length) break;
        await new Promise((resolve) => setTimeout(resolve, SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS[attempt]));
      }
      statuses[source.id] = validated || { status: "missing" };
      if (!statuses[source.id]?.found) {
        SKILL_DIAGNOSTICS && console.info("[web2ai.skill] validation result", JSON.stringify({
          skillId: skill.id,
          skillName: skill.name,
          sourceId: source.id,
          status: statuses[source.id]?.status || "missing",
          sourceFrameUrl: pageKey(source.frameUrl || ""),
          probes: statuses[source.id]?.probes || []
        }));
      }
    } catch {
      statuses[source.id] = { status: "missing" };
    }
  }));
  // 页面切换会同时产生多轮异步校验；旧页面较晚返回时不能覆盖新页面状态。
  if (validationRunId !== skillValidationRunId || !STATE.skills.some((item) => item.id === skill.id)) return;
  STATE.skillSourceStatuses[skill.id] = statuses;
  renderCallback();
}

function initSkills(onRender) {
  renderCallback = onRender || renderCallback;
  if (IS_TOP_FRAME && !businessTabClickListenerInstalled) {
    businessTabClickListenerInstalled = true;
    document.addEventListener("click", (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[class*="realTab"]') : null;
      if (!tab || !String(tab.className || "").split(/\s+/).some((name) => name.endsWith("-realTab"))) return;
      pendingBusinessTabTitle = compactOneLine(tab.textContent || "");
    }, true);
  }
  if (IS_TOP_FRAME && !pageWatchTimer) {
    observedPageKey = pageKey();
    // SPA 的 pushState/replaceState 不会重新执行 content script，也没有统一事件。
    // 轮询规范化后的页面键可同时覆盖 history API、前进后退和站点自定义路由。
    pageWatchTimer = setInterval(() => {
      const currentPageKey = pageKey();
      if (currentPageKey === observedPageKey) return;
      if (currentPageKey !== observedPageKey) {
        confirmedBusinessTabTitle = pendingBusinessTabTitle || "";
        pendingBusinessTabTitle = "";
      }
      observedPageKey = currentPageKey;
      // 查看模式跟随业务路由刷新；新建/修改模式必须保留草稿，
      // 页面切换只用于选择跨页面数据源，不能中断正在进行的编辑。
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
  saveSkillDraft, rebindSkill, removeSkillDraftSource, deleteSkill, deleteAllSkills, resolveStoredSource, switchToSkillPage,
  renameCurrentSkillPage, buildAnalysisPrompt,
  extractStoredSourceData, inspectStoredSourcePagination, collectStoredSourceData, stopStoredSourceCollection, focusStoredSource,
  saveSkillAnalysisMethod, updateSkillSourceHeaders, scheduleSkillBars,
  downloadSkillsExport, previewSkillsImport, applySkillsImport, getBusinessPageTabs
};
