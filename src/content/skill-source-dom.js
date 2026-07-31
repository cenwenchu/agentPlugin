/**
 * @fileoverview 技能数据源的 DOM 描述、定位、校验和当前页读取。
 *
 * 绑定字段和旧版定位优先级保持不变；本模块不负责技能存储或跨页采集。
 */

import { IS_TOP_FRAME, compactOneLine, web2aiDiagnosticsEnabled } from "./state.js";
import { getCssSelector, isVisibleElement } from "./dom.js";
import { skillHeadersMatch } from "./skill-collection-model.js";
import { SOURCE_LOCATOR_VERSION } from "./skill-source-model.js";
import { normalizeDerivedColumnSelections, normalizedHeaderText, SKILL_TYPE_DERIVED_COLUMN } from "./derived-column-model.js";
import { resolveTableAdapter, resolveTableRootAdapter } from "./table-adapters.js";
import { findBusinessTabElements, businessTabTitle, isJtv1LikePage } from "./business-tab-dom.js";
import { DERIVED_COLUMN_SELECTOR, getRowCells, isHeaderRow, isTableFooterOrSummaryRow } from "./table-row-dom.js";
import { findHeaderRowAbove } from "./table-header-resolver.js";
import { findPaginationNextButton } from "./table-pagination-dom.js";

const TABLE_SELECTOR = [
  "table", '[role="table"]', '[role="grid"]', '[role="treegrid"]',
  ".art-table", ".ant-table-wrapper", ".arco-table"
].join(",");
const SKILL_DIAGNOSTICS = web2aiDiagnosticsEnabled;
// 详细诊断：默认关闭。常规 DEBUG 日志保持轻量（locateStoredSource 每次渲染技能条都会跑，
// 其 candidates 逐项序列化会对每个候选表做 innerText 提取 + getCssSelector + rect 读取，
// 在大表上单次可达数百 ms）。需深挖定位细节时，控制台 window.__WEB2AI_DEBUG_VERBOSE = true。
const SKILL_DIAGNOSTICS_VERBOSE = () => Boolean(globalThis.__WEB2AI_DEBUG_VERBOSE);
const STORED_SOURCE_ACCEPT_HEADER_COVERAGE = 0.78;
const STORED_SOURCE_CHANGED_HEADER_COVERAGE = 0.45;
const STORED_SOURCE_AMBIGUOUS_SCORE_DELTA = 0.08;
// 一个采集/渲染批次经常会在极短时间内为同一 source 连续查询表格。
// 成功结果短暂复用，避免重复 querySelectorAll、表头读取和布局测量。
// 只缓存成功结果；DOM 根节点被替换后 isConnected 会立即使缓存失效。
const STORED_SOURCE_LOCATION_CACHE_MS = 500;
const storedSourceLocationCache = new WeakMap();

function storedSourceLocationCacheKey(source = {}, options = {}) {
  const resolved = resolveStoredSourceOptions(source, options);
  return JSON.stringify({
    frameUrl: source?.frameUrl || "",
    selector: source?.selector || "",
    tableIndex: Number.isInteger(source?.tableIndex) ? source.tableIndex : null,
    locatorVersion: Number(source?.locatorVersion) || 0,
    headers: Array.isArray(source?.headers) ? source.headers : [],
    skillType: resolved.skillType,
    selectedColumns: resolved.selectedColumns
  });
}

function readCachedStoredSourceLocation(source, options) {
  if (!source || typeof source !== "object" || options?.forceRefresh) return null;
  const cached = storedSourceLocationCache.get(source);
  if (!cached || cached.expiresAt < performance.now()) return null;
  if (cached.key !== storedSourceLocationCacheKey(source, options)) return null;
  if (!cached.result?.table?.isConnected) return null;
  return cached.result;
}

function cacheStoredSourceLocation(source, options, result) {
  if (!source || typeof source !== "object" || !result?.table || result.status !== "available") return;
  storedSourceLocationCache.set(source, {
    key: storedSourceLocationCacheKey(source, options),
    expiresAt: performance.now() + STORED_SOURCE_LOCATION_CACHE_MS,
    result
  });
}

function getStableTableRoot(rowEl) {
  return resolveTableAdapter(rowEl).scope;
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

function readBusinessTabDomSnapshot() {
  return findBusinessTabElements().map((tab, index) => ({
    index,
    text: businessTabTitle(tab),
    className: String(tab.element.className || "").trim().split(/\s+/).slice(0, 6),
    ariaSelected: tab.element.getAttribute?.("aria-selected") || "",
    dataActive: tab.element.getAttribute?.("data-active") || "",
    visible: isVisibleElement(tab.element)
  }));
}

function tableCandidates() {
  const candidates = Array.from(document.querySelectorAll(TABLE_SELECTOR));
  // _jtv1（聚水潭 ERP）：表头和表体是兄弟 div，共同父元素为表格根节点
  Array.from(document.querySelectorAll("#_jt_row_head")).forEach((head) => {
    const parent = head.parentElement;
    if (parent && !candidates.includes(parent)) {
      candidates.push(parent);
    }
  });
  // jtv1: #_jt 容器本身就是合法的表格候选，不依赖 #_jt_row_head 是否已渲染。
  // 当通过保存的 CSS 选择器 #_jt 重新定位时，selectorCandidateCount 需要 > 0。
  if (isJtv1LikePage()) {
    Array.from(document.querySelectorAll("#_jt")).forEach((jtContainer) => {
      if (!candidates.includes(jtContainer)) {
        candidates.push(jtContainer);
      }
    });
  }
  return candidates.filter((candidate, index) => {
    // jtv1 页面：div#_jt 是真正的表格根节点，但其外层常被 <table> 布局包裹。
    // 若父级 table 包含 jtv1 容器就过滤掉它，会导致候选池丢失真正的数据表，
    // 退化为外层布局 table，使技能条挂在页面顶部且数据采集行为不一致。
    const isJtv1Container = isJtv1LikePage() && candidate.querySelector?.("#_jt_row_head, #_jt_body, ._jt_row._jt_rh");
    return !candidates.some((parent, parentIndex) => (
      parentIndex !== index && parent.contains(candidate) && parent.matches(TABLE_SELECTOR) && !isJtv1Container
    ));
  });
}

function dataRowsInTable(table) {
  if (!table) return [];
  const adapter = resolveTableRootAdapter(table);
  if (adapter?.dataRows) {
    return adapter.dataRows(table)
      .filter((row) => !isHeaderRow(row) && !isTableFooterOrSummaryRow(row));
  }
  const matched = Array.from(table.querySelectorAll(
    "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr, ._jt_row._jt_rh"
  ));
  // 容器内嵌套表格的行不属于当前表格；但有的容器本身不含直接行
  //（如 .ant-table-wrapper 包裹原生 table），此时保留全部匹配
  const directRows = matched.filter((row) => {
    const owner = row.closest?.("table, [role='table'], [role='grid'], [role='treegrid']");
    return !owner || owner === table || !table.contains(owner);
  });
  return (directRows.length ? directRows : matched)
    .filter((row) => !isHeaderRow(row) && !isTableFooterOrSummaryRow(row));
}

function commonAncestorDistance(left, right, maxDepth = 8) {
  if (!left || !right) return -1;
  let ancestor = left;
  for (let depth = 0; ancestor && depth <= maxDepth; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.contains(right)) return depth;
  }
  return -1;
}

function resolveStoredSourceDataTable(table, source = {}) {
  if (!table) return table;
  if (dataRowsInTable(table).length) return table;
  const expectedHeaders = Array.isArray(source?.headers) ? source.headers : [];
  const fallbackHeaders = extractHeaders(table);
  const candidates = preferVisibleTables(tableCandidates())
    .filter((candidate) => candidate !== table)
    .map((candidate) => {
      const rows = dataRowsInTable(candidate);
      if (!rows.length) return null;
      const headers = extractHeaders(candidate);
      const similarity = headerSimilarity(expectedHeaders.length ? expectedHeaders : fallbackHeaders, headers);
      const distance = commonAncestorDistance(table, candidate);
      const sameParent = table.parentElement && table.parentElement === candidate.parentElement;
      return {
        table: candidate,
        rows,
        headers,
        similarity,
        distance,
        score: similarity * 10 + (sameParent ? 3 : 0) + (distance >= 0 ? Math.max(0, 4 - distance) : 0)
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff) return scoreDiff;
      const similarityDiff = right.similarity - left.similarity;
      if (similarityDiff) return similarityDiff;
      return right.rows.length - left.rows.length;
    });
  const best = candidates[0];
  if (!best) return table;
  if (best.similarity < 0.9) return table;
  SKILL_DIAGNOSTICS() && console.info("[web2ai.skill-source] resolve-data-table", JSON.stringify({
    sourceId: source?.id || "",
    fromSelector: getCssSelector(table),
    toSelector: getCssSelector(best.table),
    similarity: Number(best.similarity?.toFixed?.(4) || best.similarity || 0),
    rowCount: best.rows.length,
    distance: best.distance
  }));
  return best.table;
}

function summarizeTableCandidate(table, index = 0) {
  if (!table) return null;
  const rect = table.getBoundingClientRect?.();
  let selector = "";
  try {
    selector = getCssSelector(table);
  } catch {
    selector = "";
  }
  return {
    index,
    tag: table.tagName?.toLowerCase?.() || "",
    id: table.id || "",
    className: String(table.className || "").trim().split(/\s+/).slice(0, 6),
    visible: isVisibleElement(table),
    selector,
    title: inferTableTitle(table),
    headerCount: extractHeaders(table).length,
    headers: extractHeaders(table).slice(0, 12),
    rect: rect ? {
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0),
      top: Math.round(rect.top || 0),
      left: Math.round(rect.left || 0)
    } : null
  };
}

function resolveTableFromTarget(target) {
  if (!(target instanceof Element)) return null;
  // jtv1（聚水潭 epaas）：工具栏/按钮区域可能含 table 布局或 role 结构，
  // 通用选择器（TABLE_SELECTOR / tr / [role=row] / .ant-table-row）会把它误判为
  // 数据表格。jtv1 下只认聚水潭自己的数据表格结构（_jt_row 行 + #_jt_body/#_jt_row_head
  // 容器），禁用通用选择器兜底，避免选错按钮区域。
  if (isJtv1LikePage()) {
    const jtv1Row = target.closest("._jt_row._jt_rh");
    const jtv1Root = jtv1Row ? getStableTableRoot(jtv1Row) : null;
    if (jtv1Root) return jtv1Root;
    const jtv1Body = target.closest("#_jt_body");
    if (jtv1Body) return jtv1Body.parentElement;
    const jtv1Head = target.closest("#_jt_row_head");
    if (jtv1Head) return jtv1Head.parentElement;
    // target 本身就是 jtv1 表格容器（如 div#_jt），内部包含表格结构元素，
    // 但 closest() 向上查找不会命中（因为结构元素在 target 内部而非祖先节点）。
    // 场景：保存技能后通过 CSS 选择器 #_jt 重新定位时进入此路径。
    if (target.querySelector?.("#_jt_row_head, #_jt_body, ._jt_row._jt_rh")) return target;
    return null;
  }
  const row = target.closest("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr, ._jt_row._jt_rh");
  const componentRoot = row ? getStableTableRoot(row) : null;
  if (componentRoot) return componentRoot;
  const matched = target.closest(TABLE_SELECTOR);
  if (matched) {
    return tableCandidates().find((candidate) => candidate === matched || candidate.contains(matched)) || matched;
  }
  // _jtv1：target 在 #_jt_body 或 #_jt_row_head 内，父元素为表格根节点
  const jtv1Body = target.closest("#_jt_body");
  if (jtv1Body) return jtv1Body.parentElement;
  const jtv1Head = target.closest("#_jt_row_head");
  if (jtv1Head) return jtv1Head.parentElement;
  return null;
}

function preferVisibleTables(tables = []) {
  const uniqueTables = [...new Set((tables || []).filter(Boolean))];
  const visibleTables = uniqueTables.filter((table) => isVisibleElement(table));
  return visibleTables.length ? visibleTables : uniqueTables;
}

function cellTexts(cells) {
  return cells
    .map((cell) => compactOneLine(cell.textContent || ""))
    .filter(Boolean)
    .slice(0, 80);
}

function alignedRowCellTexts(cells, expectedColumnCount) {
  const values = [];
  for (const cell of cells.slice(0, 80)) {
    // 热路径（逐行/滚动时高频）用 textContent 而非 innerText：调用方（getRowCells/适配器）
    // 已过滤 display:none 单元格，无需 innerText 的可见性感知；innerText 会强制同步布局，
    // 在几百行表格逐行调用时造成严重 layout thrashing。
    values.push(compactOneLine(cell.textContent || ""));
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
  )).filter((cell) => !cell.matches?.(DERIVED_COLUMN_SELECTOR));
  // 适配器接管的表头（如 _jtv1 聚水潭：表头在 #_jt_row_head 子 div 中，含隐藏列需过滤）
  if (!cells.length) {
    const adapter = resolveTableRootAdapter(table);
    if (adapter?.headerCells) {
      cells = adapter.headerCells(table)
        .filter((cell) => !cell.matches?.(DERIVED_COLUMN_SELECTOR));
    }
  }
  // jtv1 兜底：当 resolveTableRootAdapter 无法匹配（scope 为函数且 matchesRoot 不满足时），
  // 直接从 #_jt_row_head 提取表头单元格，避免 fallback 到整页文本提取。
  if (!cells.length && isJtv1LikePage()) {
    const jtv1Head = table.querySelector?.("#_jt_row_head");
    if (jtv1Head) {
      cells = Array.from(jtv1Head.querySelectorAll("._jt_cell_head"))
        .filter((cell) => !cell.matches?.(DERIVED_COLUMN_SELECTOR));
    }
  }
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
    cells = firstRow
      ? Array.from(firstRow.querySelectorAll("th, td, [role='cell'], [role='gridcell'], .art-table-cell, .ant-table-cell, .arco-table-td"))
        .filter((cell) => !cell.matches?.(DERIVED_COLUMN_SELECTOR))
      : [];
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

function tableComponentType(table) {
  if (!table) return "unknown";
  if (table.matches?.(".ant-table-wrapper") || table.closest?.(".ant-table-wrapper")) return "ant";
  if (table.matches?.(".arco-table") || table.closest?.(".arco-table")) return "arco";
  if (table.matches?.(".art-table") || table.closest?.(".art-table")) return "art-table";
  if (table.matches?.("[role='grid'],[role='treegrid'],[role='table']")) return "aria";
  return table.tagName === "TABLE" ? "native" : "generic";
}

function tableContainerSignature(table) {
  if (!table) return "";
  const stable = [];
  for (let node = table, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const id = compactOneLine(node.id || "");
    const testId = compactOneLine(node.getAttribute?.("data-testid") || node.getAttribute?.("data-test-id") || "");
    const aria = compactOneLine(node.getAttribute?.("aria-label") || "");
    if (id) stable.push(`id:${id}`);
    if (testId) stable.push(`test:${testId}`);
    if (aria) stable.push(`aria:${aria}`);
  }
  const title = inferTableTitle(table);
  if (title) stable.push(`title:${title}`);
  return stable.slice(0, 5).join("|");
}

function describeTable(table, preferredTarget = null) {
  const candidates = tableCandidates();
  const headers = extractHeaders(table, preferredTarget);
  const tableTitle = inferTableTitle(table);
  const selector = getCssSelector(table);
  const tableIndex = Math.max(0, candidates.indexOf(table));
  SKILL_DIAGNOSTICS() && console.info("[web2ai.skill] selected table", {
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
    locatorVersion: SOURCE_LOCATOR_VERSION,
    selector,
    selectorStrength: selector.includes("#") ? "stable-id" : "positional",
    tableIndex,
    headers,
    headerFingerprint: headers.map(normalizeHeader).join("|"),
    preview: headers.join("、") || "未识别到数据源字段",
    tableTitle,
    componentType: tableComponentType(table),
    containerSignature: tableContainerSignature(table),
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

function normalizeTitle(value) {
  return compactOneLine(value).toLowerCase();
}

function resolveStoredSourceOptions(source = {}, options = {}) {
  return {
    skillType: String(options?.skillType || source?.skillType || "").trim(),
    selectedColumns: Array.isArray(options?.selectedColumns)
      ? options.selectedColumns
      : Array.isArray(source?.selectedColumns) ? source.selectedColumns : []
  };
}

function buildSelectedColumnCoverage(selectedColumns = [], actualHeaders = []) {
  const selections = normalizeDerivedColumnSelections(selectedColumns);
  if (!selections.length) {
    return { total: 0, matched: 0, ratio: 0, missing: [] };
  }
  const actualMeta = (Array.isArray(actualHeaders) ? actualHeaders : []).map((header, index) => ({
    index,
    header,
    normalizedHeader: normalizedHeaderText(header)
  }));
  const missing = [];
  let matched = 0;
  for (const selection of selections) {
    const matches = actualMeta.filter((item) => item.normalizedHeader === selection.normalizedHeader);
    if (matches[selection.occurrence - 1]) {
      matched += 1;
      continue;
    }
    missing.push(selection);
  }
  return {
    total: selections.length,
    matched,
    ratio: selections.length ? matched / selections.length : 0,
    missing
  };
}

function buildStoredSourceCandidate(table, source = {}, options = {}, context = {}) {
  let headers;
  if (context.headerCache?.has(table)) {
    headers = context.headerCache.get(table);
  } else {
    headers = extractHeaders(table);
    if (context.headerCache) context.headerCache.set(table, headers);
  }
  const headerCoverage = Array.isArray(source?.headers) && source.headers.length
    ? headerSimilarity(source.headers, headers)
    : 0;
  const selectedColumnCoverage = buildSelectedColumnCoverage(options.selectedColumns, headers);
  const exactHeaderMatch = Array.isArray(source?.headers) && source.headers.length
    ? skillHeadersMatch(source.headers, headers)
    : false;
  const componentTypeMatched = !source?.componentType || source.componentType === tableComponentType(table);
  const sourceContainerSignature = compactOneLine(source?.containerSignature || "");
  const actualContainerSignature = compactOneLine(tableContainerSignature(table));
  const containerSignatureMatched = !sourceContainerSignature || sourceContainerSignature === actualContainerSignature;
  const sourceTableTitle = normalizeTitle(source?.tableTitle || "");
  const actualTableTitle = normalizeTitle(inferTableTitle(table));
  const tableTitleMatched = !sourceTableTitle || (actualTableTitle && actualTableTitle === sourceTableTitle);
  const selectorMatched = context.selectorSet?.has(table) || false;
  const indexedMatched = context.indexedCandidate === table;
  const visible = isVisibleElement(table);
  const selectorStrength = String(source?.selectorStrength || "");
  let score = 0;
  score += visible ? 0.03 : 0;
  score += selectorMatched ? (selectorStrength === "stable-id" ? 0.22 : 0.08) : 0;
  score += indexedMatched ? 0.03 : 0;
  score += componentTypeMatched ? 0.08 : -0.12;
  if (sourceContainerSignature) score += containerSignatureMatched ? 0.18 : -0.12;
  if (sourceTableTitle) score += tableTitleMatched ? 0.08 : -0.05;
  score += exactHeaderMatch ? 0.35 : 0;
  score += headerCoverage * 0.28;
  score += selectedColumnCoverage.ratio * 0.30;
  const reasons = [];
  if (selectorMatched) reasons.push("selector");
  if (indexedMatched) reasons.push("tableIndex");
  if (exactHeaderMatch) reasons.push("exact-headers");
  if (selectedColumnCoverage.ratio === 1 && selectedColumnCoverage.total) reasons.push("selected-columns");
  return {
    table,
    headers,
    candidateIndex: context.candidateIndex,
    selectorMatched,
    indexedMatched,
    componentTypeMatched,
    containerSignatureMatched,
    tableTitleMatched,
    visible,
    headerCoverage,
    exactHeaderMatch,
    selectedColumnCoverage: selectedColumnCoverage.ratio,
    selectedColumnCoverageDetail: selectedColumnCoverage,
    score,
    reasons
  };
}

function candidateAcceptLevel(candidate = {}, options = {}) {
  if (candidate.exactHeaderMatch) return "exact-headers";
  if (options.skillType === SKILL_TYPE_DERIVED_COLUMN && candidate.selectedColumnCoverageDetail?.total) {
    return candidate.selectedColumnCoverage === 1 ? "selected-columns" : "";
  }
  if (candidate.headerCoverage >= STORED_SOURCE_ACCEPT_HEADER_COVERAGE) return "header-coverage";
  return "";
}

function pickBestStoredSourceCandidate(candidates = [], source = {}, options = {}) {
  if (!candidates.length) {
    return { table: null, status: "missing", candidateCount: 0, candidates: [] };
  }
  const sorted = [...candidates].sort((left, right) => {
    const scoreDiff = right.score - left.score;
    if (scoreDiff) return scoreDiff;
    const selectedDiff = (right.selectedColumnCoverage || 0) - (left.selectedColumnCoverage || 0);
    if (selectedDiff) return selectedDiff;
    const headerDiff = (right.headerCoverage || 0) - (left.headerCoverage || 0);
    if (headerDiff) return headerDiff;
    return Number(right.selectorMatched) - Number(left.selectorMatched);
  });
  const best = sorted[0];
  const second = sorted[1] || null;
  const bestAcceptLevel = candidateAcceptLevel(best, options);
  const secondAcceptLevel = second ? candidateAcceptLevel(second, options) : "";
  const ambiguous = Boolean(
    best && second &&
    Math.abs((best.score || 0) - (second.score || 0)) < STORED_SOURCE_AMBIGUOUS_SCORE_DELTA &&
    (bestAcceptLevel || secondAcceptLevel || (best.headerCoverage || 0) >= STORED_SOURCE_CHANGED_HEADER_COVERAGE)
  );
  if (ambiguous) {
    return {
      table: null,
      status: "ambiguous",
      ambiguous: true,
      candidateCount: candidates.length,
      candidates: sorted
    };
  }
  const status = bestAcceptLevel
    ? "available"
    : (best.headerCoverage >= STORED_SOURCE_CHANGED_HEADER_COVERAGE || best.selectorMatched || best.indexedMatched)
      ? "changed"
      : "missing";
  return {
    table: status === "missing" ? null : best.table,
    status,
    ambiguous: false,
    matchMethod: best.selectorMatched
      ? (String(source?.selectorStrength || "") === "stable-id" ? "stable-selector" : "selector")
      : best.indexedMatched ? "tableIndex" : "scored-candidate",
    candidateCount: candidates.length,
    candidate: best,
    candidates: sorted
  };
}

function analyzeHeaderDifferences(expected = [], actual = []) {
  const normalizedExpected = (expected || []).map((header) => normalizeHeader(header));
  const normalizedActual = (actual || []).map((header) => normalizeHeader(header));
  const expectedSet = new Set(normalizedExpected.filter(Boolean));
  const actualSet = new Set(normalizedActual.filter(Boolean));
  const missingFromActual = [];
  const addedInActual = [];
  const positionMismatches = [];
  const maxLength = Math.max(normalizedExpected.length, normalizedActual.length);
  for (let index = 0; index < maxLength; index++) {
    const expectedRaw = expected[index] ?? "";
    const actualRaw = actual[index] ?? "";
    const expectedNormalized = normalizedExpected[index] ?? "";
    const actualNormalized = normalizedActual[index] ?? "";
    if (!expectedNormalized && actualNormalized) {
      addedInActual.push({ index, header: actualRaw, normalizedHeader: actualNormalized });
      continue;
    }
    if (expectedNormalized && !actualNormalized) {
      missingFromActual.push({ index, header: expectedRaw, normalizedHeader: expectedNormalized });
      continue;
    }
    if (expectedNormalized !== actualNormalized) {
      positionMismatches.push({
        index,
        expectedHeader: expectedRaw,
        actualHeader: actualRaw,
        expectedNormalized,
        actualNormalized
      });
    }
  }
  for (let index = 0; index < normalizedExpected.length; index++) {
    const normalized = normalizedExpected[index];
    if (normalized && !actualSet.has(normalized)) {
      missingFromActual.push({
        index,
        header: expected[index],
        normalizedHeader: normalized
      });
    }
  }
  for (let index = 0; index < normalizedActual.length; index++) {
    const normalized = normalizedActual[index];
    if (normalized && !expectedSet.has(normalized)) {
      addedInActual.push({
        index,
        header: actual[index],
        normalizedHeader: normalized
      });
    }
  }
  const dedupeByIndexAndHeader = (items = []) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.index}::${item.normalizedHeader || item.expectedNormalized || ""}::${item.header || item.expectedHeader || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    expectedCount: expected.length,
    actualCount: actual.length,
    sameLength: expected.length === actual.length,
    sameNormalizedSequence: normalizedExpected.length === normalizedActual.length &&
      normalizedExpected.every((header, index) => header === normalizedActual[index]),
    firstMismatchIndex: positionMismatches[0]?.index ?? -1,
    positionMismatches: positionMismatches.slice(0, 20),
    missingFromActual: dedupeByIndexAndHeader(missingFromActual).slice(0, 20),
    addedInActual: dedupeByIndexAndHeader(addedInActual).slice(0, 20)
  };
}

function sourceMatchesCurrentFrame(source) {
  const expected = pageKey(source?.frameUrl || "");
  return !expected || expected === pageKey(location.href);
}

function locateStoredSource(source, options = {}) {
  const cached = readCachedStoredSourceLocation(source, options);
  if (cached) return cached;
  if (!sourceMatchesCurrentFrame(source)) {
    return { table: null, status: "missing", frameMismatch: true, candidateCount: 0 };
  }
  const candidates = tableCandidates();
  const visibleCandidates = preferVisibleTables(candidates);
  const resolvedOptions = resolveStoredSourceOptions(source, options);
  const versioned = Number(source?.locatorVersion) >= SOURCE_LOCATOR_VERSION;
  let selectorTables = [];
  try {
    const matches = source?.selector
      ? (versioned ? Array.from(document.querySelectorAll(source.selector)) : [document.querySelector(source.selector)].filter(Boolean))
      : [];
    const resolvedTables = matches.map(resolveTableFromTarget);
    selectorTables = preferVisibleTables(resolvedTables.filter((table) => table && (candidates.includes(table) || (isJtv1LikePage() && table.querySelector?.("#_jt_row_head, #_jt_body, ._jt_row._jt_rh")))));
    // 诊断：selector 匹配详情
    if (SKILL_DIAGNOSTICS() && source?.selector && selectorTables.length === 0) {
      console.warn("[web2ai.skill-source] selector-match-debug", JSON.stringify({
        sourceId: source?.id?.substring(0, 12),
        selector: source.selector,
        matchCount: matches.length,
        resolvedCount: resolvedTables.filter(Boolean).length,
        inCandidates: resolvedTables.map((table, i) => ({
          index: i,
          resolved: Boolean(table),
          tag: table?.tagName?.toLowerCase?.() || "",
          id: table?.id || "",
          className: String(table?.className || "").trim().split(/\s+/).slice(0, 4).join(" "),
          inCandidates: Boolean(table) && candidates.includes(table),
          hasJtv1Children: Boolean(table) && Boolean(table.querySelector?.("#_jt_row_head, #_jt_body, ._jt_row._jt_rh"))
        })),
        candidateCount: candidates.length,
        candidateTags: candidates.map((c) => `${c.tagName?.toLowerCase?.() || ""}${c.id ? `#${c.id}` : ""}.${String(c.className || "").trim().split(/\s+/).slice(0, 2).join(".")}`).slice(0, 6)
      }));
    }
  } catch (err) {
    SKILL_DIAGNOSTICS() && console.warn("[web2ai.skill-source] selector-match-error", JSON.stringify({
      sourceId: source?.id?.substring(0, 12),
      selector: source?.selector || "",
      error: String(err?.message || err || "")
    }));
    selectorTables = [];
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const preferredIndexedTable = indexedTable && !isVisibleElement(indexedTable) && visibleCandidates.length === 1
    ? visibleCandidates[0]
    : indexedTable;
  const selectorSet = new Set(selectorTables);
  const headerCache = new Map();
  const scoredCandidates = preferVisibleTables(candidates).map((table, candidateIndex) => (
    buildStoredSourceCandidate(table, source, resolvedOptions, {
      candidateIndex,
      selectorSet,
      indexedCandidate: preferredIndexedTable,
      headerCache
    })
  ));
  const chosen = pickBestStoredSourceCandidate(scoredCandidates, source, resolvedOptions);
  // 轻量摘要：每次渲染都跑，保持低开销
  SKILL_DIAGNOSTICS() && console.info("[web2ai.skill-source] locate", JSON.stringify({
    page: pageKey(location.href),
    sourceId: source?.id || "",
    sourceName: source?.displayName || source?.tableTitle || "",
    sourceBusinessTabTitle: compactOneLine(source?.businessTabTitle || ""),
    selectorCandidateCount: selectorTables.length,
    visibleCandidateCount: visibleCandidates.length,
    candidateCount: candidates.length,
    chosenMatchMethod: chosen.matchMethod,
    chosenAmbiguous: Boolean(chosen.ambiguous),
    chosenStatus: chosen.status || "missing"
  }));
  // 详细 candidates 序列化：对每个候选表做 innerText/getCssSelector/rect，开销大，
  // 仅在显式开启 verbose 时执行，避免 DEBUG 排查本身造成卡顿。
  SKILL_DIAGNOSTICS_VERBOSE() && console.info("[web2ai.skill-source] locate-detail", JSON.stringify({
    page: pageKey(location.href),
    sourceId: source?.id || "",
    sourceSelector: source?.selector || "",
    sourceTableIndex: Number.isInteger(source?.tableIndex) ? source.tableIndex : null,
    locatorVersion: Number(source?.locatorVersion) || 0,
    indexedCandidateVisible: Boolean(indexedTable && isVisibleElement(indexedTable)),
    businessTabs: readBusinessTabDomSnapshot(),
    candidates: candidates.map((table, index) => summarizeTableCandidate(table, index)),
    scoredCandidates: (chosen.candidates || scoredCandidates).map((candidate) => ({
      candidateIndex: candidate.candidateIndex,
      score: Number(candidate.score?.toFixed?.(4) || candidate.score || 0),
      selectorMatched: candidate.selectorMatched,
      indexedMatched: candidate.indexedMatched,
      exactHeaderMatch: candidate.exactHeaderMatch,
      headerCoverage: Number(candidate.headerCoverage?.toFixed?.(4) || candidate.headerCoverage || 0),
      selectedColumnCoverage: Number(candidate.selectedColumnCoverage?.toFixed?.(4) || candidate.selectedColumnCoverage || 0),
      reasons: candidate.reasons
    }))
  }));
  if (chosen.ambiguous) {
    SKILL_DIAGNOSTICS() && typeof console?.warn === "function" && console.warn("[web2ai.skill-source] locate-ambiguous", JSON.stringify({
      sourceId: source?.id?.substring(0, 12),
      candidateCount: candidates.length,
      bestScore: chosen.candidates?.[0]?.score,
      secondScore: chosen.candidates?.[1]?.score,
      bestHeaders: chosen.candidates?.[0]?.headers?.slice(0, 3),
      secondHeaders: chosen.candidates?.[1]?.headers?.slice(0, 3)
    }));
    return { table: null, status: "ambiguous", ambiguous: true, candidateCount: candidates.length };
  }
  const table = resolveStoredSourceDataTable(chosen.table, source);
  if (!table) {
    SKILL_DIAGNOSTICS() && typeof console?.warn === "function" && console.warn("[web2ai.skill-source] locate-table-not-found", JSON.stringify({
      sourceId: source?.id?.substring(0, 12),
      status: chosen.status || "missing",
      matchMethod: chosen.matchMethod,
      candidateCount: candidates.length
    }));
    return { table: null, status: chosen.status || "missing", candidateCount: candidates.length };
  }
  const identityWarnings = [];
  if (versioned && source.componentType && source.componentType !== tableComponentType(table)) identityWarnings.push("component-type-changed");
  if (versioned && source.containerSignature && source.containerSignature !== tableContainerSignature(table)) identityWarnings.push("container-signature-changed");
  const headers = chosen.candidate?.headers || extractHeaders(table);
  const headerDiff = analyzeHeaderDifferences(source?.headers || [], headers);
  const detailOptions = resolveStoredSourceOptions(source, options);
  const selectedColumnCoverageDetail = chosen.candidate?.selectedColumnCoverageDetail
    || buildSelectedColumnCoverage(detailOptions.selectedColumns, headers);
  const locateResult = {
    table,
    status: chosen.status || "available",
    matchMethod: chosen.matchMethod,
    candidateCount: candidates.length,
    identityWarnings,
    headers,
    similarity: chosen.candidate?.headerCoverage || 0,
    headerCoverage: chosen.candidate?.headerCoverage || 0,
    selectedColumnCoverage: chosen.candidate?.selectedColumnCoverage || 0,
    selectedColumnCoverageDetail,
    score: chosen.candidate?.score || 0,
    headerDiff,
    expectedHeaders: (source?.headers || []).slice(0, 80),
    actualHeaders: headers.slice(0, 80),
    candidate: chosen.candidate || null
  };
  if (locateResult.status !== "available" && SKILL_DIAGNOSTICS() && typeof console?.warn === "function") {
    console.warn("[web2ai.skill-source] locate-status-not-available", JSON.stringify({
      sourceId: source?.id?.substring(0, 12),
      status: locateResult.status,
      matchMethod: locateResult.matchMethod,
      headerCoverage: locateResult.headerCoverage,
      selectedColumnCoverage: locateResult.selectedColumnCoverage,
      score: locateResult.score,
      candidateCount: locateResult.candidateCount,
      identityWarnings: locateResult.identityWarnings,
      headersMatch: skillHeadersMatch(source?.headers || [], headers),
      expectedHeadersSample: (source?.headers || []).slice(0, 5),
      actualHeadersSample: headers.slice(0, 5),
      selectorStrength: source?.selectorStrength || "",
      hasSelector: Boolean(source?.selector),
      hasTableIndex: typeof source?.tableIndex === "number",
      componentType: source?.componentType || "",
      candidateExactHeaderMatch: chosen.candidate?.exactHeaderMatch
    }));
  }
  cacheStoredSourceLocation(source, options, locateResult);
  return locateResult;
}

function resolveStoredSource(source, options = {}) {
  const located = locateStoredSource(source, options);
  if (!located.table) return {
    found: false,
    status: located.status,
    ambiguous: located.ambiguous,
    candidateCount: located.candidateCount,
    frameMismatch: located.frameMismatch,
    frameUrl: pageKey(location.href)
  };
  const selected = located.table;
  const headers = located.headers || extractHeaders(selected);
  const similarity = located.headerCoverage ?? headerSimilarity(source?.headers || [], headers);
  const resolvedOptions = resolveStoredSourceOptions(source, options);
  const selectedColumnCoverage = buildSelectedColumnCoverage(resolvedOptions.selectedColumns, headers);
  const headerDiff = analyzeHeaderDifferences(source?.headers || [], headers);
  const diagnostic = {
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    sourceId: source?.id || "",
    sourceName: source?.displayName || source?.tableTitle || "",
    sourceBusinessTabTitle: compactOneLine(source?.businessTabTitle || ""),
    selector: source?.selector || "",
    storedTableIndex: source?.tableIndex,
    candidateCount: located.candidateCount,
    matchMethod: located.matchMethod,
    expectedHeaderCount: source?.headers?.length || 0,
    expectedHeaders: (source?.headers || []).slice(0, 80),
    actualHeaderCount: headers.length,
    actualHeaders: headers.slice(0, 80),
    headerDiff,
    selectedColumnCoverage: {
      total: selectedColumnCoverage.total,
      matched: selectedColumnCoverage.matched,
      ratio: selectedColumnCoverage.ratio,
      missing: selectedColumnCoverage.missing
    },
    similarity,
    status: located.status || (skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed"),
    selectedTable: summarizeTableCandidate(selected)
  };
  // 单行 JSON 便于从复杂业务页面控制台直接复制；仅包含表头，不输出业务数据行。
  SKILL_DIAGNOSTICS() && console.info("[web2ai.skill-source] resolve", JSON.stringify(diagnostic));
  const finalStatus = located.status || (skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed");
  // 诊断日志：非 available 状态强制输出，便于排查"保存后立即显示数据源已变化"类问题
  if (finalStatus !== "available" && SKILL_DIAGNOSTICS() && typeof console?.warn === "function") {
    console.warn("[web2ai.skill-source] source-not-available", JSON.stringify({
      sourceId: source.id?.substring(0, 12),
      skillType: options?.skillType || "",
      frameUrl: (source.frameUrl || "").substring(0, 50),
      businessTabTitle: source.businessTabTitle || "",
      status: finalStatus,
      locatedStatus: located.status || "",
      headersMatch: skillHeadersMatch(source?.headers || [], headers),
      similarity: Number(similarity.toFixed(3)),
      headerCoverage: located.headerCoverage,
      selectedColumnCoverage: located.selectedColumnCoverage,
      score: located.score || 0,
      matchMethod: located.matchMethod || "",
      candidateCount: located.candidateCount || 0,
      expectedHeadersSample: (source?.headers || []).slice(0, 5),
      actualHeadersSample: (headers || []).slice(0, 5),
      selectorStrength: source?.selectorStrength || "",
      hasSelector: Boolean(source?.selector),
      hasTableIndex: typeof source?.tableIndex === "number",
      exactHeaderMatch: located.candidate?.exactHeaderMatch
    }));
  }
  return {
    found: true,
    status: finalStatus,
    headers,
    similarity,
    headerCoverage: located.headerCoverage ?? similarity,
    selectedColumnCoverage: located.selectedColumnCoverage ?? selectedColumnCoverage.ratio,
    selectedColumnCoverageDetail: {
      total: selectedColumnCoverage.total,
      matched: selectedColumnCoverage.matched,
      ratio: selectedColumnCoverage.ratio,
      missing: selectedColumnCoverage.missing
    },
    score: located.score || 0,
    expectedHeaders: (source?.headers || []).slice(0, 80),
    actualHeaders: headers.slice(0, 80),
    headerDiff,
    identityWarnings: located.identityWarnings
  };
}

function buildRowExtractionDiagnostics(rawRows = [], headers = [], allRows = [], uniqueRows = []) {
  const summarizeRow = (row, index) => {
    const cells = getRowCells(row);
    const aligned = alignedRowCellTexts(cells, headers.length);
    const nonEmptyValues = aligned.filter(Boolean);
    return {
      index,
      tag: row.tagName?.toLowerCase?.() || "",
      className: String(row.className || "").trim().split(/\s+/).slice(0, 4),
      cellCount: cells.length,
      alignedCellCount: aligned.length,
      nonEmptyCellCount: nonEmptyValues.length
    };
  };
  return {
    headerCount: headers.length,
    rawRowCount: rawRows.length,
    alignedRowCount: allRows.length,
    uniqueRowCount: uniqueRows.length,
    sampleRows: rawRows.slice(0, 3).map(summarizeRow)
  };
}

function extractStoredSourceData(source, limit = 200, options = {}) {
  const located = locateStoredSource(source, options);
  const selected = located.table;
  if (!selected) return { found: false, status: located.status, ambiguous: located.ambiguous, candidateCount: located.candidateCount };
  const headers = located.headers || extractHeaders(selected);
  const rawRows = dataRowsInTable(selected);
  const allRows = rawRows
    .map((row) => alignedRowCellTexts(getRowCells(row), headers.length))
    .filter((cells) => cells.length && cells.some(Boolean));
  SKILL_DIAGNOSTICS() && console.info("[web2ai.derived-preview] extractStoredSourceData DOM snapshot:", {
    sourceId: source?.id || "",
    tableTag: selected?.tagName || "",
    rawRowsCount: rawRows.length,
    allRowsCount: allRows.length,
    headersCount: headers.length,
    limit,
    // 诊断只记录结构，不读取或输出业务单元格内容。
    firstRawRowTag: rawRows[0]?.tagName?.toLowerCase?.() || "",
    firstRawRowCellCount: rawRows[0] ? getRowCells(rawRows[0]).length : 0,
    firstRawRowClassCount: String(rawRows[0]?.className || "").trim().split(/\s+/).filter(Boolean).length,
    tableParentClass: selected?.parentElement?.className?.slice?.(0, 80) || ""
  });
  const uniqueRows = [];
  const seen = new Set();
  for (const row of allRows) {
    const signature = row.join("\u241f");
    if (seen.has(signature)) continue;
    seen.add(signature);
    uniqueRows.push(row);
  }
  const rows = uniqueRows.slice(0, limit);
  const extractionDiagnostics = buildRowExtractionDiagnostics(rawRows, headers, allRows, uniqueRows);
  SKILL_DIAGNOSTICS() && console.info("[web2ai.skill-source] extract-data", JSON.stringify({
    sourceId: source?.id || "",
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed",
    found: true,
    rowCount: rows.length,
    totalRowCount: uniqueRows.length,
    truncated: uniqueRows.length > rows.length,
    extractionDiagnostics
  }));
  return {
    found: true,
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed",
    headers,
    rows,
    rowCount: rows.length,
    totalRowCount: uniqueRows.length,
    truncated: uniqueRows.length > rows.length,
    extractionDiagnostics
  };
}

function extractStoredSourcePreviewData(source, limit = 20, options = {}) {
  const located = locateStoredSource(source, options);
  const selected = located.table;
  if (!selected) return { found: false, status: located.status, ambiguous: located.ambiguous, candidateCount: located.candidateCount };
  const headers = located.headers || extractHeaders(selected);
  const rawRows = dataRowsInTable(selected);
  const allRows = rawRows
    .map((row) => alignedRowCellTexts(getRowCells(row), headers.length))
    .filter((cells) => cells.length && cells.some(Boolean));
  const rows = allRows.slice(0, Math.max(1, limit));
  const extractionDiagnostics = buildRowExtractionDiagnostics(rawRows, headers, allRows, allRows);
  SKILL_DIAGNOSTICS() && console.info("[web2ai.skill-source] extract-preview", JSON.stringify({
    sourceId: source?.id || "",
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed",
    found: true,
    rowCount: rows.length,
    totalRowCount: allRows.length,
    truncated: allRows.length > rows.length,
    extractionDiagnostics
  }));
  return {
    found: true,
    status: skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed",
    headers,
    rows,
    rowCount: rows.length,
    totalRowCount: allRows.length,
    truncated: allRows.length > rows.length,
    extractionDiagnostics
  };
}

function inspectStoredSourcePagination(source, options = {}) {
  const located = locateStoredSource(source, options);
  const table = located.table;
  if (!table) return { found: false, status: located.status, ambiguous: located.ambiguous, multiPage: false };
  const anchorRow = dataRowsInTable(table)[0];
  const next = findPaginationNextButton(anchorRow);
  const pagination = next?.closest?.(".ant-pagination,.arco-pagination,#_jt_pagebar,[class*='pagination'],[role='navigation']");
  const pageNumbers = Array.from(pagination?.querySelectorAll?.("button,a,[role='button']") || [])
    .map((node) => Number.parseInt(compactOneLine(node.innerText || node.textContent || ""), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : 0;
  return { found: true, multiPage: Boolean(next || totalPages > 1), totalPages };
}


export {
  pageKey, tableCandidates, resolveTableFromTarget, alignedRowCellTexts, extractHeaders,
  describeTable, headerSimilarity, locateStoredSource, resolveStoredSource,
  extractStoredSourceData, extractStoredSourcePreviewData, inspectStoredSourcePagination,
  dataRowsInTable
};
