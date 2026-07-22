/**
 * @fileoverview 技能数据源的 DOM 描述、定位、校验和当前页读取。
 *
 * 绑定字段和旧版定位优先级保持不变；本模块不负责技能存储或跨页采集。
 */

import { DEBUG, IS_TOP_FRAME, compactOneLine } from "./state.js";
import { getCssSelector } from "./dom.js";
import { skillHeadersMatch } from "./skill-collection-model.js";
import { SOURCE_LOCATOR_VERSION, chooseSourceTableCandidate } from "./skill-source-model.js";
import { resolveTableAdapter } from "./table-adapters.js";
import { getRowCells, isHeaderRow } from "./table-row-dom.js";
import { findHeaderRowAbove } from "./table-header-resolver.js";
import { findPaginationNextButton } from "./table-pagination-dom.js";

const TABLE_SELECTOR = [
  "table", '[role="table"]', '[role="grid"]', '[role="treegrid"]',
  ".art-table", ".ant-table-wrapper", ".arco-table"
].join(",");
const SKILL_DIAGNOSTICS = DEBUG;

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

function sourceMatchesCurrentFrame(source) {
  const expected = pageKey(source?.frameUrl || "");
  return !expected || expected === pageKey(location.href);
}

function locateStoredSource(source) {
  if (!sourceMatchesCurrentFrame(source)) {
    return { table: null, status: "missing", frameMismatch: true, candidateCount: 0 };
  }
  const candidates = tableCandidates();
  const versioned = Number(source?.locatorVersion) >= SOURCE_LOCATOR_VERSION;
  let selectorTables = [];
  try {
    const matches = source?.selector
      ? (versioned ? Array.from(document.querySelectorAll(source.selector)) : [document.querySelector(source.selector)].filter(Boolean))
      : [];
    selectorTables = [...new Set(matches.map(resolveTableFromTarget).filter((table) => table && candidates.includes(table)))];
  } catch {
    selectorTables = [];
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  // 新绑定记录了更强的定位语义。selector 本身不唯一，或 selector 与保存序号
  // 指向不同组件时宁可要求重新绑定，也不能退化成任意选择。旧绑定保持原优先级。
  const chosen = chooseSourceTableCandidate({
    locatorVersion: source?.locatorVersion,
    selectorCandidates: selectorTables,
    indexedCandidate: indexedTable,
    selectorStrength: source?.selectorStrength
  });
  if (chosen.ambiguous) {
    return { table: null, status: "ambiguous", ambiguous: true, candidateCount: candidates.length };
  }
  const table = chosen.candidate;
  if (!table) return { table: null, status: "missing", candidateCount: candidates.length };
  const identityWarnings = [];
  if (versioned && source.componentType && source.componentType !== tableComponentType(table)) identityWarnings.push("component-type-changed");
  if (versioned && source.containerSignature && source.containerSignature !== tableContainerSignature(table)) identityWarnings.push("container-signature-changed");
  return {
    table,
    status: "located",
    matchMethod: chosen.matchMethod,
    candidateCount: candidates.length,
    identityWarnings
  };
}

function resolveStoredSource(source) {
  const located = locateStoredSource(source);
  if (!located.table) return {
    found: false,
    status: located.status,
    ambiguous: located.ambiguous,
    candidateCount: located.candidateCount,
    frameMismatch: located.frameMismatch,
    frameUrl: pageKey(location.href)
  };
  const selected = located.table;
  const headers = extractHeaders(selected);
  const similarity = headerSimilarity(source?.headers || [], headers);
  const diagnostic = {
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    selector: source?.selector || "",
    storedTableIndex: source?.tableIndex,
    candidateCount: located.candidateCount,
    matchMethod: located.matchMethod,
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
    similarity,
    identityWarnings: located.identityWarnings
  };
}

function extractStoredSourceData(source, limit = 200) {
  const located = locateStoredSource(source);
  const selected = located.table;
  if (!selected) return { found: false, status: located.status, ambiguous: located.ambiguous, candidateCount: located.candidateCount };
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
  const located = locateStoredSource(source);
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
  extractStoredSourceData, inspectStoredSourcePagination
};
