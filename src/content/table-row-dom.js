/**
 * @fileoverview 无状态的表格行 DOM 语义工具。
 *
 * 不读取扩展业务状态，可供表格交互、上下文和技能数据源模块共同复用。
 */

import { DEBUG } from "./state.js";

/**
 * 从任意行元素中提取单元格列表（通用实现）。
 * 支持：<tr>、[role="row"]、div-based 表格、以及各种非标准表格结构。
 */
function getRowCells(rowEl) {
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
  const directChildren = Array.from(rowEl.children).filter(c => {
    const t = c.tagName?.toLowerCase();
    return t !== "script" && t !== "style" && t !== "template" && t !== "noscript";
  });
  return directChildren;
}

/** 获取任意行元素的单元格数 */
function getCellCount(rowEl) {
  return getRowCells(rowEl).length;
}

/**
 * 判断行元素是否为表头行（通用实现）。
 * 检查 th、role=columnheader/rowheader、scope=col/row 等标准表头标记。
 */
function isHeaderRow(rowEl) {
  if (!rowEl) return false;
  // 标准 th
  if (rowEl.querySelector("th")) return true;
  // role-based 表头
  if (rowEl.querySelector('[role="columnheader"],[role="rowheader"]')) return true;
  // WCAG 标准：scope 属性标记的表头
  if (rowEl.querySelector('td[scope="col"],td[scope="row"],th[scope="col"],th[scope="row"]')) return true;
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
  if (row.querySelector("th")) return true;
  // role-based
  if (row.querySelector('[role="columnheader"], [role="rowheader"]')) return true;
  // WCAG scope 属性
  if (row.querySelector('[scope="col"], [scope="row"]')) return true;
  return false;
}

function isTableFooterOrSummaryRow(rowEl) {
  return Boolean(rowEl?.closest?.(
    "tfoot, .art-table-footer, .ant-table-summary, .ant-table-footer, " +
    ".arco-table-footer, .arco-table-summary, [role='rowgroup'][aria-label*='summary' i]"
  ));
}


export {
  getRowCells, getCellCount, isHeaderRow, isVisibleElementDiag,
  hasHeaderCells, isTableFooterOrSummaryRow
};
