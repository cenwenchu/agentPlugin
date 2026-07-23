/**
 * @fileoverview 无状态的表格行 DOM 语义工具。
 *
 * 不读取扩展业务状态，可供表格交互、上下文和技能数据源模块共同复用。
 */

import { DEBUG } from "./state.js";

const DERIVED_COLUMN_SELECTOR = "[data-web2ai-derived-column]";
const WEB2AI_UI_SELECTOR = "[data-web2ai-ui],[id^='web2ai_']";
const BUSINESS_TEXT_EXCLUDE_SELECTOR = `${DERIVED_COLUMN_SELECTOR},${WEB2AI_UI_SELECTOR}`;

function isDerivedColumnCell(cell) {
  return Boolean(cell?.matches?.(DERIVED_COLUMN_SELECTOR));
}

function filterBusinessCells(cells = []) {
  return Array.from(cells).filter((cell) => !isDerivedColumnCell(cell));
}

function extractElementBusinessText(element) {
  if (!element) return "";
  const clone = element.cloneNode?.(true);
  if (!clone) return String(element.textContent || "");
  clone.querySelectorAll?.(BUSINESS_TEXT_EXCLUDE_SELECTOR).forEach((node) => node.remove());
  return String(clone.textContent || "");
}

function normalizeBusinessText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRawRowCells(rowEl) {
  if (!rowEl) return [];
  const tag = rowEl.tagName?.toLowerCase();

  // 1. 标准 HTML 表格 <tr>
  if (tag === "tr") {
    return Array.from(rowEl.querySelectorAll("th,td"));
  }

  // 2. role=row 的 ARIA 表格
  const role = rowEl.getAttribute?.("role") || "";
  if (role === "row") {
    const cells = rowEl.querySelectorAll(
      '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]'
    );
    if (cells.length) return Array.from(cells);
  }

  // 3. 找带表格语义属性的子元素（如 scope、headers 等 WCAG 标注）
  const semanticCells = rowEl.querySelectorAll(
    'th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"],[scope]'
  );
  if (semanticCells.length) return Array.from(semanticCells);

  // 4. 兜底：取直接子元素中非 script/style/template 的作为单元格
  return Array.from(rowEl.children).filter((child) => {
    const tagName = child.tagName?.toLowerCase();
    return tagName !== "script" &&
      tagName !== "style" &&
      tagName !== "template" &&
      tagName !== "noscript";
  });
}

/**
 * 从任意行元素中提取单元格列表（通用实现）。
 * 支持：<tr>、[role="row"]、div-based 表格、以及各种非标准表格结构。
 */
function getRowCells(rowEl) {
  return filterBusinessCells(getRawRowCells(rowEl));
}

/** 获取任意行元素的单元格数 */
function getCellCount(rowEl) {
  return getRowCells(rowEl).length;
}

function getBusinessCellText(cell, { emptyPlaceholder = "" } = {}) {
  const text = normalizeBusinessText(extractElementBusinessText(cell));
  return text || emptyPlaceholder;
}

function getBusinessCellTexts(rowEl, { emptyPlaceholder = "" } = {}) {
  return getRowCells(rowEl).map((cell) => getBusinessCellText(cell, { emptyPlaceholder }));
}

function getBusinessRowText(rowEl, { separator = " ", emptyPlaceholder = "" } = {}) {
  const texts = getBusinessCellTexts(rowEl, { emptyPlaceholder });
  if (texts.length) return texts.join(separator).trim();
  return normalizeBusinessText(extractElementBusinessText(rowEl));
}

/**
 * 判断行元素是否为表头行（通用实现）。
 * 检查 th、role=columnheader/rowheader、scope=col/row 等标准表头标记。
 */
function isHeaderRow(rowEl) {
  if (!rowEl) return false;
  // 标准 th
  if (Array.from(rowEl.querySelectorAll("th")).some((cell) => !isDerivedColumnCell(cell))) return true;
  // role-based 表头
  if (Array.from(rowEl.querySelectorAll('[role="columnheader"],[role="rowheader"]')).some((cell) => !isDerivedColumnCell(cell))) return true;
  // WCAG 标准：scope 属性标记的表头
  if (Array.from(rowEl.querySelectorAll('td[scope="col"],td[scope="row"],th[scope="col"],th[scope="row"]')).some((cell) => !isDerivedColumnCell(cell))) return true;
  return false;
}

/**
 * 带诊断的 isVisibleElement — 同时输出失败原因到 console
 */
function isVisibleElementDiag(el, label) {
  if (!el || el.nodeType !== 1) {
    label && DEBUG && console.log(`[web2ai] isVisible DIAG: ${label}: el is null or not element`);
    return false;
  }
  const style = window.getComputedStyle(el);
  if (style.display === "none") {
    DEBUG && console.log(`[web2ai] isVisible DIAG: ${label || el.tagName}: display=none`);
    return false;
  }
  if (style.visibility === "hidden") {
    DEBUG && console.log(`[web2ai] isVisible DIAG: ${label || el.tagName}: visibility=hidden`);
    return false;
  }
  if (Number(style.opacity || "1") === 0) {
    DEBUG && console.log(`[web2ai] isVisible DIAG: ${label || el.tagName}: opacity=0`);
    return false;
  }
  const rect = el.getBoundingClientRect?.();
  if (!rect || rect.width < 2 || rect.height < 2) {
    DEBUG && console.log(`[web2ai] isVisible DIAG: ${label || el.tagName}: rect w=${rect?.width} h=${rect?.height} (too small)`);
    return false;
  }
  return true;
}

/**
 * 检查行元素是否包含表头单元格（通用实现）。
 */
function hasHeaderCells(row) {
  if (!row) return false;
  // th 元素
  if (Array.from(row.querySelectorAll("th")).some((cell) => !isDerivedColumnCell(cell))) return true;
  // role-based
  if (Array.from(row.querySelectorAll('[role="columnheader"], [role="rowheader"]')).some((cell) => !isDerivedColumnCell(cell))) return true;
  // WCAG scope 属性
  if (Array.from(row.querySelectorAll('[scope="col"], [scope="row"]')).some((cell) => !isDerivedColumnCell(cell))) return true;
  return false;
}

function isTableFooterOrSummaryRow(rowEl) {
  return Boolean(rowEl?.closest?.(
    "tfoot, .art-table-footer, .ant-table-summary, .ant-table-footer, " +
    ".arco-table-footer, .arco-table-summary, [role='rowgroup'][aria-label*='summary' i]"
  ));
}


export {
  DERIVED_COLUMN_SELECTOR, BUSINESS_TEXT_EXCLUDE_SELECTOR,
  getRowCells, getCellCount, getBusinessCellText, getBusinessCellTexts, getBusinessRowText,
  isHeaderRow, isVisibleElementDiag, hasHeaderCells, isTableFooterOrSummaryRow
};
