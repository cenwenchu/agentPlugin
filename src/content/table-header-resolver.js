/**
 * @fileoverview 跨固定表头、兄弟 table 和 ARIA 表格查找对应表头行。
 */

import { DEBUG } from "./state.js";
import { isVisibleElement } from "./dom.js";
import { hasHeaderCells, isVisibleElementDiag } from "./table-row-dom.js";

/**
 * 向上追溯查找行对应的表头行（通用版本）。
 * 
 * 策略：
 *   1. 同一 table 内查找（thead 或前面含 th 的 tr）
 *   2. 沿 DOM 树逐级向上，在每级的父容器中扫描所有兄弟元素
 *   3. 优先选择 DOM 顺序中"在前面"的元素
 *   4. 最后在离行最近的 body/dialog 区域内做兜底搜索
 * 
 * @param {Element} rowEl - 数据行元素
 * @returns {Element|null} 找到的表头行元素，或 null
 */
function findHeaderRowAbove(rowEl) {
  if (!rowEl) { DEBUG && console.log("[web2ai] findHeaderRowAbove: rowEl is null"); return null; }

  DEBUG && console.log("[web2ai] findHeaderRowAbove START: rowEl.tagName=" + rowEl.tagName
    + " className=" + (rowEl.className?.slice?.(0, 60) || "")
  );

  // === Step 1: 同表内查找 ===
  if (rowEl.tagName === "TR") {
    const table = rowEl.closest("table");
    if (table) {
      DEBUG && console.log("[web2ai] findHeaderRowAbove step1: table.rows=" + table.rows.length);
      const theadRow = table.querySelector("thead tr");
      if (theadRow && hasHeaderCells(theadRow)) {
        DEBUG && console.log("[web2ai] findHeaderRowAbove FOUND via step1-thead, cells=" + theadRow.querySelectorAll("th,td").length);
        return theadRow;
      }
      // 在前面 tr 中找含 th 的行
      const allRows = table.querySelectorAll("tr");
      let checked = 0;
      for (const r of allRows) {
        if (r === rowEl) break;
        checked++;
        if (hasHeaderCells(r)) {
          DEBUG && console.log("[web2ai] findHeaderRowAbove FOUND via step1-tr, index=" + (checked - 1));
          return r;
        }
      }
      DEBUG && console.log("[web2ai] findHeaderRowAbove step1: checked " + checked + " preceding trs, none had th");
    } else {
      DEBUG && console.log("[web2ai] findHeaderRowAbove step1: row is TR but no closest table");
    }
  }

  // === Step 2: 逐级向上扫描祖先的兄弟节点 ===
  let current = rowEl;
  let depth = 0;
  while (current && current !== document.body && current !== document.documentElement) {
    const parent = current.parentElement;
    if (!parent) { current = current.parentElement; continue; }

    const children = parent.children;
    if (children.length > 1) {
      if (depth < 5) {
        DEBUG && console.log(`[web2ai] step2-depth${depth}: parent=<${parent.tagName}${parent.className ? '.'+parent.className.slice(0,30):''}> children=${children.length}`);
        for (let i = 0; i < Math.min(children.length, 8); i++) {
          const c = children[i];
          const marker = c === current ? " **CURRENT**" : "";
          DEBUG && console.log(`  [${i}] <${c.tagName}${c.className ? '.'+c.className.slice(0,30):''}>${marker}`);
        }
      }
      const found = scanChildrenForHeader(children, current, rowEl);
      if (found) return found;
    }
    current = parent;
    depth++;
  }

  // === Step 3: 兜底 — 在 row 所在的"区域"内搜索 ===
  const region = rowEl.closest("body, dialog, [role='dialog'], [role='tabpanel'], [role='region']");
  if (region) {
    const found = findHeaderRowInElement(region, rowEl);
    if (found) {
      DEBUG && console.log("[web2ai] findHeaderRowAbove FOUND via step3-region: " + (region.tagName) + (region.id ? "#" + region.id : ""));
      return found;
    }
  }

  DEBUG && console.log("[web2ai] findHeaderRowAbove RESULT: NOT FOUND");
  return null;
}

/**
 * 在兄弟元素列表中查找表头行。
 * 优先选 DOM 顺序中"在 currentEl 前面"的元素。
 */
function scanChildrenForHeader(children, currentEl, rowEl) {
  let bestBefore = null;
  let bestAfter = null;

  for (const child of children) {
    if (child === currentEl) continue;
    const headerRow = findHeaderRowInElement(child);
    if (headerRow) {
      // 判断 child 在 currentEl 之前还是之后
      if (child.compareDocumentPosition(currentEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
        // child 在 currentEl 前面
        bestBefore = headerRow;
        DEBUG && console.log(`[web2ai] scanChildren: found BEFORE in <${child.tagName}${child.className ? '.'+child.className.slice(0,30):''}>, header=<${headerRow.tagName}${headerRow.className ? '.'+headerRow.className.slice(0,30):''}>`);
        break; // 找到前面的就立即返回
      } else {
        // child 在 currentEl 后面
        if (!bestAfter) {
          bestAfter = headerRow;
          DEBUG && console.log(`[web2ai] scanChildren: found AFTER in <${child.tagName}${child.className ? '.'+child.className.slice(0,30):''}>, header=<${headerRow.tagName}${headerRow.className ? '.'+headerRow.className.slice(0,30):''}>`);
        }
      }
    } else if (child.children?.length) {
      // 诊断：children > 0 但没有找到 header，输出一下
      DEBUG && console.log(`[web2ai] scanChildren: no header in sibling <${child.tagName}${child.className ? '.'+child.className.slice(0,30):''}> (children=${child.children.length})`);
    }
  }

  if (bestBefore) {
    DEBUG && console.log("[web2ai] findHeaderRowAbove FOUND via scanChildren-before: "
      + bestBefore.tagName + " cells=" + (bestBefore.querySelectorAll?.("th,td")?.length || "?"));
    return bestBefore;
  }
  if (bestAfter) {
    DEBUG && console.log("[web2ai] findHeaderRowAbove FOUND via scanChildren-after: "
      + bestAfter.tagName + " cells=" + (bestAfter.querySelectorAll?.("th,td")?.length || "?"));
    return bestAfter;
  }
  return null;
}

/**
 * 在一个容器元素中查找表头行（通用实现）。
 * 检测 th、role=columnheader、scope=col/row 等标准表头标记。
 * @param {Element} container - 容器元素
 * @param {Element} afterEl - 可选，只查找此元素之前的行（用于同表内顺序查找）
 */
function findHeaderRowInElement(container, afterEl) {
  if (!container || !isVisibleElement(container)) {
    // 诊断：输出为什么不可见
    if (container) DEBUG && isVisibleElementDiag(container, `findHeaderRowInElement: <${container.tagName}${container.className ? '.'+container.className.slice(0,30):''}>`);
    return null;
  }

  // 优先找 thead
  const theadRow = container.querySelector?.("thead tr");
  if (theadRow && hasHeaderCells(theadRow)) return theadRow;

  // 找所有含表头标记的 tr
  const trs = container.querySelectorAll?.("tr") || [];
  for (const tr of trs) {
    if (afterEl && tr === afterEl) break;
    if (hasHeaderCells(tr)) return tr;
  }

  // role-based 表格：找有 columnheader 或 scope 的 row
  const roleContainer = container.querySelector?.('[role="table"], [role="grid"], [role="treegrid"]') || container;
  const rows = roleContainer.querySelectorAll?.('[role="row"]') || [];
  for (const row of rows) {
    if (afterEl && row === afterEl) break;
    if (hasHeaderCells(row)) return row;
  }

  // 通用兜底：找容器内任何带了表头标记的子元素
  const anyHeader = container.querySelector?.(
    '[scope="col"], [scope="row"], [role="columnheader"], [role="rowheader"]'
  );
  if (anyHeader) {
    // 向上追溯到行级元素
    const rowLike = anyHeader.closest?.("tr") || anyHeader.closest?.('[role="row"]');
    if (rowLike) return rowLike;
  }

  return null;
}


export { findHeaderRowAbove };
