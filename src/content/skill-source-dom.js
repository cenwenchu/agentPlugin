/**
 * @fileoverview 技能数据源的 DOM 描述、定位、校验和当前页读取。
 *
 * 绑定字段和旧版定位优先级保持不变；本模块不负责技能存储或跨页采集。
 */

import { DEBUG, IS_TOP_FRAME, compactOneLine } from "./state.js";
import { getCssSelector, isVisibleElement } from "./dom.js";
import { skillHeadersMatch } from "./skill-collection-model.js";
import { SOURCE_LOCATOR_VERSION } from "./skill-source-model.js";
import { normalizeDerivedColumnSelections, normalizedHeaderText, SKILL_TYPE_DERIVED_COLUMN } from "./derived-column-model.js";
import { resolveTableAdapter } from "./table-adapters.js";
import { DERIVED_COLUMN_SELECTOR, getRowCells, isHeaderRow, isTableFooterOrSummaryRow } from "./table-row-dom.js";
import { findHeaderRowAbove } from "./table-header-resolver.js";
import { findPaginationNextButton } from "./table-pagination-dom.js";

const TABLE_SELECTOR = [
  "table", '[role="table"]', '[role="grid"]', '[role="treegrid"]',
  ".art-table", ".ant-table-wrapper", ".arco-table"
].join(",");
const SKILL_DIAGNOSTICS = DEBUG;
const STORED_SOURCE_ACCEPT_HEADER_COVERAGE = 0.78;
const STORED_SOURCE_CHANGED_HEADER_COVERAGE = 0.45;
const STORED_SOURCE_AMBIGUOUS_SCORE_DELTA = 0.08;

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
  return Array.from(document.querySelectorAll('[class*="realTab"]'))
    .filter((element) => String(element.className || "").split(/\s+/).some((name) => name.endsWith("-realTab")))
    .map((element, index) => ({
      index,
      text: compactOneLine(element.textContent || ""),
      className: String(element.className || "").trim().split(/\s+/).slice(0, 6),
      ariaSelected: element.getAttribute?.("aria-selected") || "",
      dataActive: element.getAttribute?.("data-active") || "",
      visible: isVisibleElement(element)
    }));
}

function tableCandidates() {
  const candidates = Array.from(document.querySelectorAll(TABLE_SELECTOR));
  return candidates.filter((candidate, index) => !candidates.some((parent, parentIndex) => (
    parentIndex !== index && parent.contains(candidate) && parent.matches(TABLE_SELECTOR)
  )));
}

function dataRowsInTable(table) {
  if (!table) return [];
  return Array.from(table.querySelectorAll("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"))
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
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill-source] resolve-data-table", JSON.stringify({
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
  const row = target.closest("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const componentRoot = row ? getStableTableRoot(row) : null;
  if (componentRoot) return componentRoot;
  const matched = target.closest(TABLE_SELECTOR);
  if (!matched) return null;
  return tableCandidates().find((candidate) => candidate === matched || candidate.contains(matched)) || matched;
}

function preferVisibleTables(tables = []) {
  const uniqueTables = [...new Set((tables || []).filter(Boolean))];
  const visibleTables = uniqueTables.filter((table) => isVisibleElement(table));
  return visibleTables.length ? visibleTables : uniqueTables;
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
  )).filter((cell) => !cell.matches?.(DERIVED_COLUMN_SELECTOR));
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
  const headers = extractHeaders(table);
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
    selectorTables = preferVisibleTables(matches.map(resolveTableFromTarget).filter((table) => table && candidates.includes(table)));
  } catch {
    selectorTables = [];
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const preferredIndexedTable = indexedTable && !isVisibleElement(indexedTable) && visibleCandidates.length === 1
    ? visibleCandidates[0]
    : indexedTable;
  const selectorSet = new Set(selectorTables);
  const scoredCandidates = preferVisibleTables(candidates).map((table, candidateIndex) => (
    buildStoredSourceCandidate(table, source, resolvedOptions, {
      candidateIndex,
      selectorSet,
      indexedCandidate: preferredIndexedTable
    })
  ));
  const chosen = pickBestStoredSourceCandidate(scoredCandidates, source, resolvedOptions);
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill-source] locate", JSON.stringify({
    page: pageKey(location.href),
    sourceId: source?.id || "",
    sourceName: source?.displayName || source?.tableTitle || "",
    sourceBusinessTabTitle: compactOneLine(source?.businessTabTitle || ""),
    sourceSelector: source?.selector || "",
    sourceTableIndex: Number.isInteger(source?.tableIndex) ? source.tableIndex : null,
    locatorVersion: Number(source?.locatorVersion) || 0,
    selectorCandidateCount: selectorTables.length,
    visibleCandidateCount: visibleCandidates.length,
    candidateCount: candidates.length,
    indexedCandidateVisible: Boolean(indexedTable && isVisibleElement(indexedTable)),
    chosenMatchMethod: chosen.matchMethod,
    chosenAmbiguous: Boolean(chosen.ambiguous),
    chosenStatus: chosen.status || "missing",
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
    return { table: null, status: "ambiguous", ambiguous: true, candidateCount: candidates.length };
  }
  const table = resolveStoredSourceDataTable(chosen.table, source);
  if (!table) return { table: null, status: chosen.status || "missing", candidateCount: candidates.length };
  const identityWarnings = [];
  if (versioned && source.componentType && source.componentType !== tableComponentType(table)) identityWarnings.push("component-type-changed");
  if (versioned && source.containerSignature && source.containerSignature !== tableContainerSignature(table)) identityWarnings.push("container-signature-changed");
  const headers = chosen.candidate?.headers || extractHeaders(table);
  const headerDiff = analyzeHeaderDifferences(source?.headers || [], headers);
  const detailOptions = resolveStoredSourceOptions(source, options);
  const selectedColumnCoverageDetail = chosen.candidate?.selectedColumnCoverageDetail
    || buildSelectedColumnCoverage(detailOptions.selectedColumns, headers);
  return {
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
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill-source] resolve", JSON.stringify(diagnostic));
  return {
    found: true,
    status: located.status || (skillHeadersMatch(source?.headers || [], headers) ? "available" : "changed"),
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
  const rawRows = Array.from(selected.querySelectorAll("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"))
    .filter((row) => !isHeaderRow(row) && !isTableFooterOrSummaryRow(row));
  const allRows = rawRows
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
  const extractionDiagnostics = buildRowExtractionDiagnostics(rawRows, headers, allRows, uniqueRows);
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill-source] extract-data", JSON.stringify({
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
  const rawRows = Array.from(selected.querySelectorAll("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"))
    .filter((row) => !isHeaderRow(row) && !isTableFooterOrSummaryRow(row));
  const allRows = rawRows
    .map((row) => alignedRowCellTexts(getRowCells(row), headers.length))
    .filter((cells) => cells.length && cells.some(Boolean));
  const rows = allRows.slice(0, Math.max(1, limit));
  const extractionDiagnostics = buildRowExtractionDiagnostics(rawRows, headers, allRows, allRows);
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill-source] extract-preview", JSON.stringify({
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
  const anchorRow = table.querySelector?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const next = findPaginationNextButton(anchorRow);
  const pagination = next?.closest?.(".ant-pagination,.arco-pagination,[class*='pagination'],[role='navigation']");
  const pageNumbers = Array.from(pagination?.querySelectorAll?.("button,a,[role='button']") || [])
    .map((node) => Number.parseInt(compactOneLine(node.innerText || node.textContent || ""), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : 0;
  return { found: true, multiPage: Boolean(next || totalPages > 1), totalPages };
}


export {
  pageKey, tableCandidates, resolveTableFromTarget, alignedRowCellTexts, extractHeaders,
  describeTable, headerSimilarity, locateStoredSource, resolveStoredSource,
  extractStoredSourceData, extractStoredSourcePreviewData, inspectStoredSourcePagination
};
