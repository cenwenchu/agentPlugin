/**
 * @fileoverview AI自定义列运行期原生插列渲染。
 */

import { getRowCells, hasHeaderCells } from "./table-row-dom.js";

const RUNTIME_STYLE_ID = "web2ai_derived_runtime_style";
const RUNTIME_CELL_ATTR = "data-web2ai-derived-column";
const RUNTIME_HEADER_ATTR = "data-web2ai-derived-column-header";
const RUNTIME_COL_ATTR = "data-web2ai-derived-column-col";
const RUNTIME_NOTE_ATTR = "data-web2ai-derived-runtime-note";
const RUNTIME_ROOT_ATTR = "data-web2ai-derived-runtime-root";
const RUNTIME_SKILL_ATTR = "data-web2ai-derived-runtime-skill";
const DEFAULT_OUTPUT_COLUMN_NAME = "智能分析结论";

function ensureDerivedRuntimeStyle() {
  if (document.getElementById(RUNTIME_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = RUNTIME_STYLE_ID;
  style.textContent = `
    [${RUNTIME_CELL_ATTR}],
    [${RUNTIME_HEADER_ATTR}] {
      box-sizing: border-box;
      min-width: var(--web2ai-derived-column-width, 110px);
      width: var(--web2ai-derived-column-width, 110px);
      max-width: var(--web2ai-derived-column-width, 110px);
      vertical-align: top;
      background: inherit;
    }

    [${RUNTIME_HEADER_ATTR}] {
      font-weight: 600;
      color: #166534;
      white-space: nowrap;
      background: #f0fdf4;
      box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.14);
    }

    [${RUNTIME_ROOT_ATTR}] {
      display: block;
      width: 100%;
    }

    [${RUNTIME_NOTE_ATTR}] {
      display: block;
      width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid #86efac;
      background: #dcfce7;
      color: #14532d;
      font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: normal;
      word-break: break-word;
      box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.08);
    }

    [${RUNTIME_NOTE_ATTR}][data-status="loading"],
    [${RUNTIME_NOTE_ATTR}][data-status="pending"] {
      border-color: #fde68a;
      background: #fffbeb;
      color: #92400e;
      box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.08);
    }

    [${RUNTIME_NOTE_ATTR}][data-status="error"] {
      border-color: #fecaca;
      background: #fef2f2;
      color: #991b1b;
      box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.08);
    }
  `;
  document.documentElement.appendChild(style);
}

function formatRuntimeNoteText({ status = "pending", conclusion = "", error = "" } = {}) {
  if (status === "blocked") {
    return String(
      error ||
      conclusion ||
      "当前页面已触发访问保护；列表变化后会重新判断，但模型请求仍受当前页面总额度限制。"
    ).trim();
  }
  if (status === "error") return `分析失败：${String(error || conclusion || "请稍后重试").trim()}`;
  if (status === "complete") return String(conclusion || "已完成").trim();
  if (status === "loading") return "分析中...";
  return "等待分析";
}

function estimateColumnWidth({
  items = [],
  outputColumnName = DEFAULT_OUTPUT_COLUMN_NAME
} = {}) {
  const lengths = [String(outputColumnName || DEFAULT_OUTPUT_COLUMN_NAME).trim().length];
  for (const item of Array.isArray(items) ? items : []) {
    lengths.push(formatRuntimeNoteText(item).length);
  }
  const longest = Math.max(...lengths, 0);
  if (longest <= 10) return 90;
  if (longest <= 16) return 110;
  if (longest <= 24) return 130;
  if (longest <= 34) return 160;
  return 190;
}

function getNonDerivedCells(rowEl) {
  if (!rowEl) return [];
  if (rowEl.tagName === "TR") {
    return Array.from(rowEl.children).filter((cell) => !cell.matches?.(`[${RUNTIME_CELL_ATTR}]`));
  }
  return Array.from(rowEl.children || []).filter((cell) => !cell.matches?.(`[${RUNTIME_CELL_ATTR}]`));
}

function resolveInsertChild(rowEl, insertIndex = 0, expectedCount = 0) {
  const cells = getNonDerivedCells(rowEl);
  const extraLeadingCells = Math.max(0, cells.length - Math.max(0, expectedCount));
  const domIndex = Math.max(0, Math.min(insertIndex + extraLeadingCells, cells.length));
  return cells[domIndex] || null;
}

function resolveHeaderRow(root, headerCount = 0) {
  const rows = Array.from(root?.querySelectorAll?.("thead tr, [role='row']") || []);
  const headerRows = rows.filter((row) => hasHeaderCells(row));
  if (!headerRows.length) return null;
  if (!headerCount) return headerRows.at(-1) || null;
  return headerRows.findLast((row) => getRowCells(row).length >= Math.max(1, headerCount - 1)) || headerRows.at(-1) || null;
}

function ensureDerivedColgroup(root, {
  skillId = "",
  insertIndex = 0,
  headerCount = 0
} = {}) {
  const colgroups = Array.from(root?.querySelectorAll?.("colgroup") || []);
  for (const colgroup of colgroups) {
    let col = colgroup.querySelector(`[${RUNTIME_COL_ATTR}="${skillId}"]`);
    if (!col) {
      col = document.createElement("col");
      col.setAttribute(RUNTIME_COL_ATTR, skillId);
      const cols = Array.from(colgroup.children || []);
      const extraLeadingCols = Math.max(0, cols.length - Math.max(0, headerCount));
      const before = cols[Math.max(0, Math.min(insertIndex + extraLeadingCols, cols.length))] || null;
      colgroup.insertBefore(col, before);
    }
  }
}

function applyColumnWidth(root, skillId = "", width = 220) {
  const value = `${Math.max(90, Math.min(210, Number(width) || 110))}px`;
  const targets = root?.querySelectorAll?.(
    `[${RUNTIME_CELL_ATTR}="${skillId}"],[${RUNTIME_HEADER_ATTR}="${skillId}"],[${RUNTIME_COL_ATTR}="${skillId}"]`
  ) || [];
  for (const node of targets) {
    if (node.tagName === "COL") {
      node.style.width = value;
      node.style.minWidth = value;
      continue;
    }
    node.style.setProperty("--web2ai-derived-column-width", value);
  }
}

function ensureDerivedHeader(root, {
  skillId = "",
  insertIndex = 0,
  outputColumnName = DEFAULT_OUTPUT_COLUMN_NAME,
  headerCount = 0
} = {}) {
  const headerRow = resolveHeaderRow(root, headerCount);
  if (!headerRow) return null;
  let header = headerRow.querySelector(`[${RUNTIME_HEADER_ATTR}="${skillId}"]`);
  if (!header) {
    header = document.createElement(headerRow.tagName === "TR" ? "th" : "div");
    header.setAttribute("data-web2ai-ui", "1");
    header.setAttribute(RUNTIME_CELL_ATTR, skillId);
    header.setAttribute(RUNTIME_HEADER_ATTR, skillId);
    header.setAttribute(RUNTIME_SKILL_ATTR, skillId);
    if (header.tagName === "TH") header.scope = "col";
    const before = resolveInsertChild(headerRow, insertIndex, headerCount);
    headerRow.insertBefore(header, before);
  }
  header.textContent = String(outputColumnName || DEFAULT_OUTPUT_COLUMN_NAME).trim() || DEFAULT_OUTPUT_COLUMN_NAME;
  header.title = header.textContent;
  return header;
}

function ensureDerivedBodyCell(rowEl, {
  skillId = "",
  insertIndex = 0,
  headerCount = 0
} = {}) {
  let cell = rowEl.querySelector(`[${RUNTIME_CELL_ATTR}="${skillId}"]:not([${RUNTIME_HEADER_ATTR}])`);
  if (!cell) {
    cell = document.createElement(rowEl.tagName === "TR" ? "td" : "div");
    cell.setAttribute("data-web2ai-ui", "1");
    cell.setAttribute(RUNTIME_CELL_ATTR, skillId);
    cell.setAttribute(RUNTIME_SKILL_ATTR, skillId);
    const before = resolveInsertChild(rowEl, insertIndex, headerCount);
    rowEl.insertBefore(cell, before);
  }
  let root = cell.querySelector(`[${RUNTIME_ROOT_ATTR}]`);
  if (!root) {
    root = document.createElement("div");
    root.setAttribute("data-web2ai-ui", "1");
    root.setAttribute(RUNTIME_ROOT_ATTR, "1");
    root.setAttribute(RUNTIME_SKILL_ATTR, skillId);
    cell.appendChild(root);
  }
  let note = root.querySelector(`[${RUNTIME_NOTE_ATTR}]`);
  if (!note) {
    note = document.createElement("div");
    note.setAttribute("data-web2ai-ui", "1");
    note.setAttribute(RUNTIME_NOTE_ATTR, "1");
    note.setAttribute(RUNTIME_SKILL_ATTR, skillId);
    root.appendChild(note);
  }
  return note;
}

function renderDerivedRuntimeNote({
  skillId = "",
  rowEl = null,
  status = "pending",
  conclusion = "",
  error = "",
  insertIndex = 0,
  headerCount = 0
} = {}) {
  if (!rowEl?.isConnected) return false;
  const note = ensureDerivedBodyCell(rowEl, { skillId, insertIndex, headerCount });
  if (!note) return false;
  note.dataset.status = status;
  note.textContent = formatRuntimeNoteText({ status, conclusion, error });
  note.title = note.textContent;
  return true;
}

function renderDerivedRuntimeNotes(skillId = "", items = [], options = {}) {
  const connectedItems = (Array.isArray(items) ? items : []).filter((item) => item?.rowEl?.isConnected);
  if (!connectedItems.length) return 0;
  const root = options?.root || connectedItems[0]?.rowEl?.closest?.("table,[role='table'],[role='grid']");
  if (!root) return 0;
  ensureDerivedRuntimeStyle();
  ensureDerivedColgroup(root, {
    skillId,
    insertIndex: options?.insertIndex || 0,
    headerCount: options?.headerCount || 0
  });
  ensureDerivedHeader(root, {
    skillId,
    insertIndex: options?.insertIndex || 0,
    outputColumnName: options?.outputColumnName || DEFAULT_OUTPUT_COLUMN_NAME,
    headerCount: options?.headerCount || 0
  });
  const width = estimateColumnWidth({
    items: connectedItems,
    outputColumnName: options?.outputColumnName || DEFAULT_OUTPUT_COLUMN_NAME
  });
  let renderedCount = 0;
  for (const item of connectedItems) {
    if (renderDerivedRuntimeNote({
      skillId,
      rowEl: item.rowEl,
      status: item.status,
      conclusion: item.conclusion,
      error: item.error,
      insertIndex: options?.insertIndex || 0,
      headerCount: options?.headerCount || 0
    })) {
      renderedCount += 1;
    }
  }
  applyColumnWidth(root, skillId, width);
  return renderedCount;
}

function clearDerivedRuntimeSkill(skillId = "", root = document) {
  if (!skillId || !root?.querySelectorAll) return 0;
  const nodes = Array.from(root.querySelectorAll(
    `[${RUNTIME_CELL_ATTR}="${skillId}"],[${RUNTIME_COL_ATTR}="${skillId}"]`
  ));
  for (const node of nodes) node.remove();
  return nodes.length;
}

export {
  RUNTIME_CELL_ATTR,
  RUNTIME_HEADER_ATTR,
  RUNTIME_NOTE_ATTR,
  RUNTIME_ROOT_ATTR,
  clearDerivedRuntimeSkill,
  ensureDerivedRuntimeStyle,
  formatRuntimeNoteText,
  renderDerivedRuntimeNote,
  renderDerivedRuntimeNotes
};
