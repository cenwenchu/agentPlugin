/**
 * @fileoverview 表格交互核心。
 *
 * 职责：
 * - 检测鼠标悬停的表格行（tr / role="row" / div 表格）
 * - 鼠标停稳后显示行级“问AI”操作，选中后在第一列显示 ✓
 * - 行数据提取（通用 getRowCells，支持多种表格结构）
 * - 表头自动识别与匹配（thead / th / columnheader / scope）
 * - 批量选择（全选当前页、跨页选择）
 * - 跨页翻页自动化（支持 Ant Design / Arco Design 分页器自动翻页）
 * - 行高亮、选中 pinned overlay
 *
 * 通用设计：不依赖特定 UI 框架，通过标准 HTML 语义和 ARIA 属性识别表格。
 */

import { DEBUG, IS_TOP_FRAME, STATE, COL_SEPARATOR, refs, clamp, normalizeText, compactOneLine, uid, TABLE_UI_Z_INDEX } from './state.js';
import { el, getCssSelector, getOverlayBoundsForElement, findRowElementFromEventTarget, isVisibleElement } from './dom.js';
import { addContextSnippet, removeContextByRef, extractTableRowText } from './context.js';
import { showToast } from './toast.js';
import { render } from './overlay.js';
import { createContextRef, isContextRef } from './context-ref.js';
import { getBusinessRowKey, getRenderedRowIdentity, getRowContentFingerprint, resolveTableAdapter } from './table-adapters.js';

// ========== UI 框架类名常量（避免硬编码） ==========

/** Ant Design / Arco Design 抽屉和弹窗容器选择器 */
const DRAWER_MODAL_SELECTORS = ".ant-drawer-body, .ant-modal-body, .arco-drawer-body, .arco-modal-body";

/** Ant Design 分页禁用 class */
const ANT_PAGINATION_DISABLED = "ant-pagination-disabled";

/** Arco Design 分页禁用 class */
const ARCO_PAGINATION_DISABLED = "arco-pagination-item-disabled";

/** 同 URL 的多个 iframe 也必须拥有不同的表格命名空间。 */
const FRAME_TABLE_SCOPE = uid();

// ========== 通用表格辅助函数 ==========

/**
 * 开发态诊断记录。仅保存在内容脚本隔离世界的内存中，不写入页面 DOM，
 * 避免业务页面脚本读取已选行摘要，也避免生产环境持续 JSON 序列化。
 */
function recordTableDiagnostic(event, detail = {}) {
  if (!DEBUG) return;
  const entry = { at: Date.now(), event, ...detail };
  refs.tableDiagnostics.push(entry);
  if (refs.tableDiagnostics.length > 120) refs.tableDiagnostics.splice(0, refs.tableDiagnostics.length - 120);
}

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

function getStableTableRoot(rowEl) {
  return resolveTableAdapter(rowEl).scope;
}

/**
 * 组件容器级表格身份。项目不再做刷新恢复，因此使用当前页面生命周期内的实例 key：
 * 固定表头和表体共享同一根节点；同页结构完全相同的多个组件也绝不会碰撞。
 */
function getTableIdForRow(rowEl) {
  const { adapter, scope: root } = resolveTableAdapter(rowEl);
  if (!root) return "";
  let tableKey = refs.tableRootToKey.get(root);
  if (!tableKey) {
    const selector = getCssSelector(root) || root.tagName?.toLowerCase?.() || "table";
    tableKey = `${location.href}::frame:${FRAME_TABLE_SCOPE}::${adapter.name}::instance:${refs.nextTableInstanceId++}::${selector}`;
    refs.tableRootToKey.set(root, tableKey);
  }
  return tableKey;
}

function getCurrentPageIndex(rowEl) {
  const container = rowEl?.closest?.(DRAWER_MODAL_SELECTORS) || document;
  const active = container.querySelector?.(
    ".ant-pagination-item-active, .arco-pagination-item-active, [aria-current='page']"
  );
  const value = Number(compactOneLine(active?.textContent || ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function highlightRow(rowEl, on) {
  if (!rowEl) return;
  if (on) {
    rowEl.dataset.web2aiSelected = "1";
    if (!document.getElementById("web2ai_table_row_style")) {
      const style = document.createElement("style");
      style.id = "web2ai_table_row_style";
      style.textContent = `
        tr[data-web2ai-selected="1"],
        [role="row"][data-web2ai-selected="1"] {
          outline: 2px solid rgba(59, 130, 246, 0.65);
          outline-offset: -2px;
          background: rgba(59, 130, 246, 0.08) !important;
        }
      `;
      document.documentElement.appendChild(style);
    }
  } else {
    delete rowEl.dataset.web2aiSelected;
  }
}

function getVirtualRowPositionKey(rowEl, tableId = getTableIdForRow(rowEl)) {
  const rowIndex = rowEl?.getAttribute?.("data-rowindex");
  if (rowIndex == null || rowIndex === "") return "";
  const { adapter } = resolveTableAdapter(rowEl);
  // ArtTable 的 data-rowindex 是组件提供的数据位置。它的虚拟占位布局不保证
  // scrollHeight/clientHeight 比例稳定，因此不能用滚动高度来决定是否启用去重。
  if (adapter.name !== "art" && !detectVirtualScroll(rowEl, 0)) return "";
  const pageIndex = getCurrentPageIndex(rowEl) ?? 1;
  return `${tableId || location.href}::page:${pageIndex}::virtual-index:${rowIndex}`;
}

/**
 * ArtTable 顶部常驻行与虚拟行必须使用同一种稳定身份。其后续业务列可能异步刷新，
 * 因此无业务 key 时以“序号 + 订单号”这前两个非空列识别；其他表格仍用通用三列指纹。
 */
function getRowRenderedIdentity(rowEl, tableId, businessRowKey, text) {
  const { adapter } = resolveTableAdapter(rowEl);
  if (!businessRowKey && adapter.name === "art") {
    const fingerprint = getRowContentFingerprint(text, 2);
    return fingerprint ? `${tableId || "unknown-table"}::${fingerprint}` : "";
  }
  return getRenderedRowIdentity(tableId, businessRowKey, text);
}

/**
 * 虚拟滚动会把一个仍连接在 DOM 中的行节点改写为另一条数据。此时只解除旧快照
 * 与该节点的 UI 绑定，不能删除旧上下文；旧内容已经作为文本快照安全保存在内存中。
 */
function reconcileRecycledRow(rowEl) {
  const previousRef = refs.selectedRowRef.get(rowEl);
  if (!isAddedRef(previousRef)) return;
  if (isTableFooterOrSummaryRow(rowEl)) {
    removePinnedRowOverlay(rowEl);
    highlightRow(rowEl, false);
    refs.selectedRowRef.delete(rowEl);
    if (refs.refToRowEl.get(previousRef) === rowEl) refs.refToRowEl.delete(previousRef);
    refs.refToCheckbox.delete(previousRef);
    return;
  }
  // 表头不是虚拟数据行，排序/筛选状态改变也不应取消其选中渲染。
  if (isHeaderRow(rowEl)) return;
  const tableId = getTableIdForRow(rowEl);
  const businessRowKey = getBusinessRowKey(rowEl);
  const text = extractTableRowText(rowEl).trim();
  const currentIdentity = getRowRenderedIdentity(rowEl, tableId, businessRowKey, text);
  const previousIdentity = refs.refToRenderedRowIdentity.get(previousRef);
  // 虚拟列表会在相同 data-rowindex 上复用 DOM 节点。位置只能帮助重新绑定，
  // 不能覆盖身份判断；无业务 row key 时必须让内容指纹识别数据已变化。
  if (!previousIdentity || previousIdentity === currentIdentity) return;

  recordTableDiagnostic("reconcile-changed", {
    ref: previousRef,
    rowIndex: rowEl.getAttribute?.("data-rowindex") || "",
    previousIdentity,
    currentIdentity
  });

  removePinnedRowOverlay(rowEl);
  highlightRow(rowEl, false);
  refs.selectedRowRef.delete(rowEl);
  if (refs.refToRowEl.get(previousRef) === rowEl) refs.refToRowEl.delete(previousRef);
  refs.refToCheckbox.delete(previousRef);
}

/**
 * 虚拟表格可能销毁旧行节点，再为同一条业务数据创建新节点。上下文快照仍然有效，
 * 因此这里按业务 key/内容指纹把新节点重新绑定到原 ref，恢复勾选和高亮，而不是重复加入。
 */
function restoreSelectedRowBinding(rowEl, { tableId, businessRowKey, text, renderedIdentity } = {}) {
  if (!rowEl || isHeaderRow(rowEl) || isTableFooterOrSummaryRow(rowEl)) return null;
  tableId ||= getTableIdForRow(rowEl);
  businessRowKey ||= getBusinessRowKey(rowEl);
  if (text == null) text = extractTableRowText(rowEl).trim();
  if (!text) return null;
  renderedIdentity ||= getRowRenderedIdentity(rowEl, tableId, businessRowKey, text);
  const rowKey = businessRowKey ? `${tableId || location.href}::${businessRowKey}` : "";
  // 虚拟位置会被下一条业务数据复用，不能作为恢复身份的依据。
  // 有 key 用业务 key；无 key 用包含前导列内容的渲染指纹。
  const ref = (rowKey && refs.rowKeyToRef.get(rowKey)) ||
    (renderedIdentity && refs.renderedRowIdentityToRef.get(renderedIdentity));
  if (!isAddedRef(ref)) {
    // 分页组件可能缓存并重新挂载旧 DOM。全量清空后索引已经不存在，
    // 此时必须顺便移除节点自身残留的 dataset/标记，避免视觉假选中。
    removePinnedRowOverlay(rowEl);
    highlightRow(rowEl, false);
    refs.selectedRowRef.delete(rowEl);
    return null;
  }

  const previousRowEl = refs.refToRowEl.get(ref);
  if (previousRowEl && previousRowEl !== rowEl) {
    removePinnedRowOverlay(previousRowEl);
    highlightRow(previousRowEl, false);
    if (refs.selectedRowRef.get(previousRowEl) === ref) refs.selectedRowRef.delete(previousRowEl);
  }
  refs.selectedRowRef.set(rowEl, ref);
  refs.refToRowEl.set(ref, rowEl);
  highlightRow(rowEl, true);
  ensurePinnedRowOverlay(rowEl, ref);
  recordTableDiagnostic("restore-binding", {
    ref,
    rowIndex: rowEl.getAttribute?.("data-rowindex") || "",
    renderedIdentity
  });
  return ref;
}

function findRefByRenderedIdentity(renderedIdentity) {
  if (!renderedIdentity) return null;
  const direct = refs.renderedRowIdentityToRef.get(renderedIdentity);
  if (isAddedRef(direct)) return direct;
  // 双向索引可能因跨 frame UI 清理短暂不同步；反向索引仍是可靠的已加入证据。
  for (const [ref, identity] of refs.refToRenderedRowIdentity.entries()) {
    if (identity !== renderedIdentity || !isAddedRef(ref)) continue;
    refs.renderedRowIdentityToRef.set(renderedIdentity, ref);
    return ref;
  }
  return null;
}

function addRowElToContext(rowEl, { silent } = {}) {
  if (!rowEl) return 0;
  if (isTableFooterOrSummaryRow(rowEl)) return 0;
  const t0 = performance.now();
  reconcileRecycledRow(rowEl);
  const existing = refs.selectedRowRef.get(rowEl);
  if (isAddedRef(existing)) {
    recordTableDiagnostic("skip-dom-ref", { ref: existing, rowIndex: rowEl.getAttribute?.("data-rowindex") || "" });
    return 0;
  }
  const tableId = getTableIdForRow(rowEl);
  const businessRowKey = getBusinessRowKey(rowEl);
  const virtualPosition = getVirtualRowPositionKey(rowEl, tableId);
  // 相同业务 key 可能出现在页面上的不同表格，必须绑定组件级 tableId。
  const rowKey = businessRowKey ? `${tableId || location.href}::${businessRowKey}` : "";
  if (rowKey && isAddedRef(refs.rowKeyToRef.get(rowKey))) {
    const ref = restoreSelectedRowBinding(rowEl, { tableId, businessRowKey });
    recordTableDiagnostic("skip-row-key", { rowKey, ref });
    return 0;
  }
  const text = extractTableRowText(rowEl).trim();
  if (!text) return 0;
  const renderedIdentity = getRowRenderedIdentity(rowEl, tableId, businessRowKey, text);
  const identityRef = findRefByRenderedIdentity(renderedIdentity);
  if (isAddedRef(identityRef)) {
    const ref = restoreSelectedRowBinding(rowEl, { tableId, businessRowKey, text, renderedIdentity });
    recordTableDiagnostic("skip-fingerprint", { renderedIdentity, ref });
    return 0;
  }
  const textPreview = compactOneLine(text).slice(0, 60);
  DEBUG && console.log(`[web2ai] addRowElToContext adding text="${textPreview}"`, rowEl);
  
  // 诊断入口：确认函数被调用
  DEBUG && console.log(`[web2ai] addRowElToContext ENTRY: tagName=${rowEl.tagName} IS_TOP_FRAME=${IS_TOP_FRAME} silent=${!!silent}`);
  // 每个 frame 都能独立采集，随机 ref 避免 iframe 之间的递增编号冲突。
  const ref = createContextRef();
  refs.selectedRowRef.set(rowEl, ref);
  refs.refToRowEl.set(ref, rowEl);
  if (virtualPosition) {
    refs.virtualRowPositionToRef.set(virtualPosition, ref);
    refs.refToVirtualRowPosition.set(ref, virtualPosition);
  }
  if (renderedIdentity) {
    refs.refToRenderedRowIdentity.set(ref, renderedIdentity);
    refs.renderedRowIdentityToRef.set(renderedIdentity, ref);
  }
  recordTableDiagnostic("add", {
    ref,
    rowIndex: rowEl.getAttribute?.("data-rowindex") || "",
    tableId,
    renderedIdentity,
    columns: text.split(COL_SEPARATOR).slice(0, 5)
  });
  if (rowKey) {
    refs.rowKeyToRef.set(rowKey, ref);
    refs.refToRowKey.set(ref, rowKey);
  }
  try {
    const cb = refs.tableRowFab?.querySelector?.("#web2ai_table_row_checkbox");
    if (cb) refs.refToCheckbox.set(ref, cb);
  } catch {}
  highlightRow(rowEl, true);
  ensurePinnedRowOverlay(rowEl, ref);
  const isHeader = isHeaderRow(rowEl);
  const kind = isHeader ? "table-header" : "table-row";
  const pageIndex = getCurrentPageIndex(rowEl);
  refs.refToRowMeta.set(ref, { tableId, pageIndex, kind });
  const cellCount = getCellCount(rowEl);
  let matchedHeaderRow = null;
  if (isHeader) {
    DEBUG && console.log(`[web2ai] addRowElToContext HEADER row added: cellCount=${cellCount}`, dumpRowCellDetail(rowEl));
    // 详细日志：手工选中表头时，输出完整结构信息，方便对比
    DEBUG && console.log(`[web2ai] addRowElToContext HEADER_MANUAL: ref=${ref} cellCount=${cellCount}`, dumpRowCellDetail(rowEl));
    const headerTable = rowEl.closest("table");
    const headerThead = rowEl.closest("thead");
    DEBUG && console.log(`[web2ai] HEADER_MANUAL structure:`, {
      tagName: rowEl.tagName,
      className: rowEl.className?.slice?.(0, 60) || "",
      role: rowEl.getAttribute?.("role") || "",
      closestTable: headerTable?.tagName || "none",
      tableClassName: headerTable?.className?.slice?.(0, 60) || "",
      inThead: !!headerThead,
      parentTag: rowEl.parentElement?.tagName || "",
      parentClassName: rowEl.parentElement?.className?.slice?.(0, 60) || "",
      cells: rowEl.tagName === "TR" ? Array.from(rowEl.querySelectorAll("th,td")).map((c, i) => ({
        i, tag: c.tagName, text: c.textContent?.trim?.().slice?.(0, 30) || ""
      })) : "not TR",
      ancestorChain: (() => {
        const chain = [];
        let e = rowEl.parentElement;
        let depth = 0;
        while (e && e !== document.body && depth < 8) {
          chain.push(e.tagName + (e.id ? "#" + e.id : "") + (e.className ? "." + e.className.slice(0, 20) : ""));
          e = e.parentElement;
          depth++;
        }
        return chain.join(" > ");
      })()
    });
  }
  if (!isHeader) {
    // 详细日志：数据行结构信息，方便与表头对比
    DEBUG && console.log(`[web2ai] addRowElToContext DATA_ROW: ref=${ref} cellCount=${cellCount} IS_TOP_FRAME=${IS_TOP_FRAME}`, dumpRowCellDetail(rowEl));
    const dataTable = rowEl.closest("table");
    DEBUG && console.log(`[web2ai] DATA_ROW structure:`, {
      tagName: rowEl.tagName,
      className: rowEl.className?.slice?.(0, 60) || "",
      role: rowEl.getAttribute?.("role") || "",
      closestTable: dataTable?.tagName || "none",
      tableClassName: dataTable?.className?.slice?.(0, 60) || "",
      parentTag: rowEl.parentElement?.tagName || "",
      parentClassName: rowEl.parentElement?.className?.slice?.(0, 60) || "",
      ancestorChain: (() => {
        const chain = [];
        let e = rowEl.parentElement;
        let depth = 0;
        while (e && e !== document.body && depth < 8) {
          chain.push(e.tagName + (e.id ? "#" + e.id : "") + (e.className ? "." + e.className.slice(0, 20) : ""));
          e = e.parentElement;
          depth++;
        }
        return chain.join(" > ");
      })()
    });
    const found = findHeaderRowAbove(rowEl);
    if (found) {
      const headerText = extractTableRowText(found).trim();
      const headerCellCount = getCellCount(found);
      const rowCellCount = cellCount || text.split(COL_SEPARATOR).length;
      if (headerText && headerCellCount === rowCellCount) {
        matchedHeaderRow = found;
        if (!isAddedRef(refs.selectedRowRef.get(found))) {
          // 每张表独立添加自己的表头，不能复用其他相同列数表格的表头。
          DEBUG && console.log(`[web2ai] addRowElToContext auto-adding matched header, cells=${headerCellCount}`);
          addRowElToContext(found, { silent: true });
        }
      } else {
        DEBUG && console.log(`[web2ai] addRowElToContext header above has different columns (${headerCellCount} vs ${rowCellCount}), proceeding as headerless`);
      }
    } else {
      DEBUG && console.log(`[web2ai] addRowElToContext no header found above, proceeding as headerless`);
    }
  }

  addContextSnippet({
    kind,
    text,
    url: location.href,
    title: document.title,
    ref,
    rowEl,
    cellCount,
    tableId,
    headerRef: matchedHeaderRow ? refs.selectedRowRef.get(matchedHeaderRow) || "" : "",
    pageIndex,
    rowKey,
    silent: Boolean(silent)
  });

  // 输出加入上下文的行日志，方便对比表头和数据行
  {
    const cols = text.split(COL_SEPARATOR);
    const label = isHeader ? "表头" : "数据行";
    const detail = cols.map((col, i) => `[${i}] ${col}`).join(", ");
    DEBUG && console.log(`[web2ai] ${label} ${ref}: ${detail}`);
  }

  if (!isHeader) {
    refs.batchAnchorRow = rowEl;
    refs.batchTableId = tableId;
    refs.batchPageIndex = pageIndex;
    // 通用：尝试找表格容器
    const parentTableEl = rowEl.closest("table") || rowEl.closest('[role="grid"]') || rowEl.closest('[role="table"]');
    if (parentTableEl) {
      refs.batchTableRoot = parentTableEl;
      DEBUG && console.log(`[web2ai] addRowElToContext batchTableRoot set:`, parentTableEl, `tableIndex=${Array.from(document.querySelectorAll("table")).indexOf(parentTableEl)}`);
    }
    refs.batchContainer = rowEl.closest(DRAWER_MODAL_SELECTORS) ||
      rowEl.closest('[class*="drawer"i] [class*="body"i]') ||
      rowEl.closest('[class*="modal"i] [class*="body"i]') ||
      null;
    updateBatchBar();
  }
  const elapsed = performance.now() - t0;
  if (elapsed > 10) DEBUG && console.log(`[web2ai] addRowElToContext SLOW: ${elapsed.toFixed(1)}ms silent=${silent} kind=${kind} ref=${ref}`);

  // 闪光动画 + 自动展开采（silent 模式跳过）
  if (!silent) {
    ensureAddedFlashStyle();
    rowEl.classList.add("web2ai-row-added");
    setTimeout(() => rowEl.classList.remove("web2ai-row-added"), 800);
    DEBUG && console.log(`[web2ai] auto-open check: STATE.open=${STATE.open}, silent=${!!silent}`);
    if (!STATE.open) { STATE.open = true; render(); DEBUG && console.log(`[web2ai] auto-open: set STATE.open=true, called render`); }
  }

  return 1;
}

/** 注入添加行时的闪光动画 CSS */
function ensureAddedFlashStyle() {
  if (document.getElementById("web2ai_added_flash_style")) return;
  const style = document.createElement("style");
  style.id = "web2ai_added_flash_style";
  style.textContent = `
    @keyframes web2ai-added-flash {
      0%   { box-shadow: inset 0 0 0 0px rgba(59,130,246,0.45); }
      30%  { box-shadow: inset 0 0 0 4px rgba(59,130,246,0.35); }
      100% { box-shadow: inset 0 0 0 12px rgba(59,130,246,0); }
    }
    .web2ai-row-added {
      animation: web2ai-added-flash 0.7s ease-out;
    }
  `;
  document.documentElement.appendChild(style);
}

function handleRowCheckboxChange(checked) {
  if (!STATE.launcherVisible) {
    syncRowCheckboxState(false);
    return;
  }
  const rowEl = refs.hoveredRow;
  if (!rowEl) return;
  syncRowCheckboxState(checked);

  const tableEl = rowEl.tagName === "TR" ? rowEl.closest("table") : null;
  if (tableEl) {
    const allTables = document.querySelectorAll("table");
    const tableIdx = Array.from(allTables).indexOf(tableEl);
    const tableContent = getTableContentDigest(tableEl);
    DEBUG && console.log(`[web2ai] handleRowCheckboxChange ${checked ? "选中" : "取消"} row, tableIndex=${tableIdx}, table=`, tableEl, `digest="${tableContent}"`);
    allTables.forEach((t, i) => {
      if (t.isConnected) {
        const visible = isVisibleElement(t);
        const rect = t.getBoundingClientRect();
        DEBUG && console.log(`[web2ai]   allTables[${i}]: connected visible=${visible} rect=${JSON.stringify({w:Math.round(rect.width),h:Math.round(rect.height)})} digest="${getTableContentDigest(t)}"`);
      }
    });
  } else {
    DEBUG && console.log(`[web2ai] handleRowCheckboxChange ${checked ? "选中" : "取消"} row, rowEl.tagName=${rowEl.tagName} (not a TR, no parent table)`);
  }

  if (checked) {
    const ok = addRowElToContext(rowEl);
    if (!ok) {
      syncRowCheckboxState(false);
      return;
    }
    return;
  }

  const ref = refs.selectedRowRef.get(rowEl);
  if (isAddedRef(ref)) removeContextByRef(ref);
  if (refs.batchAnchorRow === rowEl) {
    const rows = getRowGroupRows(rowEl);
    refs.batchAnchorRow = rows.find((r) => isAddedRef(refs.selectedRowRef.get(r))) || null;
  }
  updateBatchBar();
}

function syncRowCheckboxState(checked) {
  const a = refs.tableRowFab?.querySelector?.("#web2ai_table_row_checkbox");
  const aBefore = a?.checked;
  if (a && a.checked !== checked) a.checked = checked;
  const b = refs.inlineRowFab?.querySelector?.("#web2ai_table_row_inline_checkbox");
  const bBefore = b?.checked;
  if (b && b.checked !== checked) b.checked = checked;
  DEBUG && console.log(`[web2ai] syncRowCheckboxState(${checked}) fab=${aBefore}->${a?.checked} inline=${bBefore}->${b?.checked} tableRowFab=`, refs.tableRowFab, `inlineRowFab=`, refs.inlineRowFab);
}

function ensureTableRowFab() {
  if (refs.tableRowFab) return;
  refs.tableRowFab = el("label", {
    id: "web2ai_table_row_fab",
    title: "勾选：把该行内容加入上下文，发送给 AI",
    onClick: (e) => e.stopPropagation(),
    style: {
      position: "fixed",
      zIndex: TABLE_UI_Z_INDEX,
      display: "none",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: "6px",
      cursor: "pointer",
      userSelect: "none",
      pointerEvents: "auto"
    }
  });

  const box = el("span", {
    style: {
      display: "none",
      width: "26px",
      height: "26px",
      borderRadius: "8px",
      background: "rgba(255,255,255,0.98)",
      border: "1px solid rgba(0,0,0,0.22)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      alignItems: "center",
      justifyContent: "center"
    }
  });
  const input = el("input", {
    id: "web2ai_table_row_checkbox",
    type: "checkbox",
    title: "问 AI（加入上下文）",
    style: {
      width: "18px",
      height: "18px",
      margin: "0"
    }
  });
  box.appendChild(input);
  refs.tableRowFab.appendChild(box);

  const askAction = el(
      "span",
      {
        id: "web2ai_table_row_ask_ai",
        style: {
          fontSize: "11px",
          lineHeight: "1",
          padding: "6px 10px 6px 12px",
          borderRadius: "999px",
          background: "rgba(17,24,39,0.92)",
          color: "#fff",
          border: "1px solid rgba(0,0,0,0.12)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          whiteSpace: "nowrap"
        }
      },
      ["问AI"]
    );
  refs.tableRowFab.appendChild(askAction);
  askAction.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleRowCheckboxChange(true);
    hideTableRowFab();
  });

  input.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  input.addEventListener("change", (e) => {
    e.stopPropagation();
    handleRowCheckboxChange(input.checked);
  });

  document.documentElement.appendChild(refs.tableRowFab);
}

function ensureInlineRowFab() {
  if (refs.inlineRowFab) return;
  refs.inlineRowFab = el("label", {
    id: "web2ai_table_row_inline_fab",
    title: "勾选：把该行内容加入上下文，发送给 AI",
    onClick: (e) => e.stopPropagation(),
    style: {
      position: "absolute",
      right: "6px",
      top: "4px",
      zIndex: "3",
      display: "none",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: "6px",
      cursor: "pointer",
      userSelect: "none",
      pointerEvents: "auto"
    }
  });

  const box = el("span", {
    style: {
      width: "26px",
      height: "26px",
      borderRadius: "8px",
      background: "rgba(255,255,255,0.98)",
      border: "1px solid rgba(0,0,0,0.22)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }
  });
  const input = el("input", {
    id: "web2ai_table_row_inline_checkbox",
    type: "checkbox",
    title: "问 AI（加入上下文）",
    style: {
      width: "18px",
      height: "18px",
      margin: "0"
    }
  });
  box.appendChild(input);
  refs.inlineRowFab.appendChild(box);

  refs.inlineRowFab.appendChild(
    el(
      "span",
      {
        style: {
          fontSize: "11px",
          lineHeight: "1",
          padding: "6px 10px 6px 12px",
          borderRadius: "999px",
          background: "rgba(17,24,39,0.92)",
          color: "#fff",
          border: "1px solid rgba(0,0,0,0.12)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          whiteSpace: "nowrap"
        }
      },
      ["问AI"]
    )
  );

  input.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  input.addEventListener("change", (e) => {
    e.stopPropagation();
    handleRowCheckboxChange(input.checked);
  });
}

function showInlineRowFab(rowEl) {
  if (!STATE.launcherVisible) {
    hideInlineRowFab();
    return;
  }
  ensureInlineRowFab();
  if (!refs.inlineRowFab) return;
  if (isTableFooterOrSummaryRow(rowEl)) {
    hideInlineRowFab();
    return;
  }
  // Hover 期间页面可能正在刷新实时指标。内容变化本身不足以证明虚拟行已被
  // 复用；已选中的 DOM 行必须优先保留绑定，避免 ✓ 消失并重新出现“问AI”。
  const selectedRef = refs.selectedRowRef.get(rowEl);
  if (isAddedRef(selectedRef)) {
    ensurePinnedRowOverlay(rowEl, selectedRef);
    hideInlineRowFab();
    return;
  }
  if (!isAddedRef(refs.selectedRowRef.get(rowEl))) restoreSelectedRowBinding(rowEl);
  if (refs.pinnedRowOverlays.has(rowEl)) {
    hideInlineRowFab();
    return;
  }
  const cell = getRowInlineAnchorCell(rowEl);
  if (!cell) {
    hideInlineRowFab();
    return;
  }
  const pos = window.getComputedStyle(cell).position;
  if (pos === "static") cell.style.position = "relative";
  if (refs.inlineRowFabHost && refs.inlineRowFabHost !== cell) {
    refs.inlineRowFab.remove();
    refs.inlineRowFabHost = null;
  }
  refs.hoveredRow = rowEl;
  const input = refs.inlineRowFab.querySelector("#web2ai_table_row_inline_checkbox");
  if (input) input.checked = Boolean(refs.selectedRowRef.get(rowEl));
  if (!cell.contains(refs.inlineRowFab)) cell.appendChild(refs.inlineRowFab);
  refs.inlineRowFabHost = cell;
  refs.inlineRowFab.style.display = "flex";
}

function hideInlineRowFab() {
  if (!refs.inlineRowFab) return;
  refs.inlineRowFab.style.display = "none";
  refs.inlineRowFab.remove();
  refs.inlineRowFabHost = null;
}

function ensurePinnedRowOverlay(rowEl, ref) {
  if (!rowEl || !ref) return;
  const existingNode = refs.pinnedRowOverlays.get(rowEl);
  if (existingNode?.isConnected) return;
  // 单元格局部重绘可能移除 check 节点，但保留原 row DOM 和 Map 项。
  if (existingNode) refs.pinnedRowOverlays.delete(rowEl);

  // 通用判断：TR 或 tbody 内的 row 或 rowgroup 内的 row 用 inline 定位（跟随滚动）
  const isInline = rowEl.tagName === "TR" ||
    (rowEl.getAttribute?.("role") === "row" && (
      rowEl.closest("tbody") || rowEl.closest('[role="rowgroup"]')
    ));
  const inlineCell = isInline ? getRowSelectedAnchorCell(rowEl) : null;
  const node = el("div", {
    "data-web2ai-ui": true,
    "data-web2ai-inline": isInline && inlineCell ? "1" : "0",
    style: {
      position: isInline && inlineCell ? "absolute" : "fixed",
      right: isInline && inlineCell ? "6px" : null,
      top: isInline && inlineCell ? "4px" : null,
      // 内联标记位于表格单元格内部，不需要全局 999；使用与悬停 checkbox
      // 相同的局部层级，避免压住站点挂到 body 上的 Dropdown/Popover。
      zIndex: isInline && inlineCell ? "3" : TABLE_UI_Z_INDEX,
      display: "flex",
      alignItems: "center",
      gap: "6px",
      cursor: "pointer",
      userSelect: "none",
      pointerEvents: "none"
    }
  });

  const action = el(
      "span",
      {
        "data-web2ai-pinned-action": true,
        style: {
          fontSize: "11px",
          lineHeight: "1",
          padding: "6px 10px",
          borderRadius: "999px",
          background: "rgba(17,24,39,0.92)",
          color: "#fff",
          border: "1px solid rgba(0,0,0,0.12)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
          whiteSpace: "nowrap",
          cursor: "pointer",
          pointerEvents: "auto"
        }
      },
      ["✓"]
  );
  node.appendChild(action);

  action.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeContextByRef(ref);
    updateBatchBar();
  });

  refs.pinnedRowOverlays.set(rowEl, node);
  if (isInline && inlineCell) {
    const pos = window.getComputedStyle(inlineCell).position;
    if (pos === "static") inlineCell.style.position = "relative";
    inlineCell.appendChild(node);
  } else {
    document.documentElement.appendChild(node);
    positionPinnedRowOverlay(rowEl);
  }
}

function removePinnedRowOverlay(rowEl) {
  const node = refs.pinnedRowOverlays.get(rowEl);
  if (node) node.remove();
  refs.pinnedRowOverlays.delete(rowEl);
}

function positionPinnedRowOverlay(rowEl) {
  if (!rowEl) return;
  // 跳过内联定位的行（TR 或在 tbody/rowgroup 内的 role=row）
  if (rowEl.tagName === "TR") return;
  if (rowEl.getAttribute?.("role") === "row" && (
    rowEl.closest("tbody") || rowEl.closest('[role="rowgroup"]')
  )) return;
  const node = refs.pinnedRowOverlays.get(rowEl);
  if (!node) return;
  if (!rowEl.isConnected) {
    removePinnedRowOverlay(rowEl);
    return;
  }
  const rect = getRowAnchorRect(rowEl);
  if (!rect || rect.width === 0 || rect.height === 0) {
    node.style.display = "none";
    return;
  }
  node.style.display = "flex";
  const pad = 6;
  const width = 92;
  const height = 26;
  const bounds = getOverlayBoundsForElement(rowEl);
  const top = clamp(
    rect.top + rect.height / 2 - height / 2,
    Math.max(pad, bounds.top),
    Math.min(window.innerHeight - height - pad, bounds.bottom - height - pad)
  );
  const left = clamp(
    rect.left - width,
    Math.max(pad, bounds.left),
    Math.min(window.innerWidth - width - pad, bounds.right - width - pad)
  );
  node.style.top = `${top}px`;
  node.style.left = `${left}px`;
}

function getRowAnchorRect(rowEl) {
  if (!rowEl) return null;
  const rect = rowEl.getBoundingClientRect?.();
  if (rect && rect.width > 0 && rect.height > 0) return rect;

  const cell = rowEl.querySelector?.(
    "td,th,[role='cell'],[role='gridcell'],[role='columnheader'],[role='rowheader']"
  );
  const cellRect = cell?.getBoundingClientRect?.();
  if (cellRect && cellRect.width > 0 && cellRect.height > 0) return cellRect;

  const parentRect = rowEl.parentElement?.getBoundingClientRect?.();
  if (parentRect && parentRect.width > 0 && parentRect.height > 0) return parentRect;

  return rect || null;
}

function showTableRowFabAt(rect, rowEl, pointer) {
  if (isTableFooterOrSummaryRow(rowEl)) {
    hideTableRowFab();
    return;
  }
  hideInlineRowFab();
  ensureTableRowFab();
  // 实时数据页面会在鼠标移动期间更新单元格文本。Hover 不负责判定虚拟节点
  // 复用：已有选中绑定时始终保留 ✓，并且不再显示“问AI”。真正的节点复用
  // 由滚动/重绘后的 restoreRenderedSelectionState 统一校验。
  const selectedRef = refs.selectedRowRef.get(rowEl);
  if (isAddedRef(selectedRef)) {
    ensurePinnedRowOverlay(rowEl, selectedRef);
    refs.tableRowFab.style.display = "none";
    refs.hoveredRow = rowEl;
    return;
  }
  // 同一行内只在首次进入时定位：靠近首次进入点，但不会继续追随鼠标。
  if (refs.hoveredRow === rowEl && refs.tableRowFab.style.display === "flex") return;
  if (!isAddedRef(refs.selectedRowRef.get(rowEl))) restoreSelectedRowBinding(rowEl);
  if (isAddedRef(refs.selectedRowRef.get(rowEl))) {
    refs.tableRowFab.style.display = "none";
    return;
  }
  refs.hoveredRow = rowEl;
  const input = refs.tableRowFab.querySelector("#web2ai_table_row_checkbox");
  if (input) input.checked = Boolean(refs.selectedRowRef.get(rowEl));
  const pad = 6;
  const bounds = getOverlayBoundsForElement(rowEl);
  const height = 26;
  const width = 92;
  const rowTop = Math.max(pad, bounds.top, rect.top);
  const rowBottom = Math.min(window.innerHeight - pad, bounds.bottom, rect.bottom);
  const top = clamp(
    (pointer?.y ?? rect.top + rect.height / 2) - height / 2,
    rowTop,
    Math.max(rowTop, rowBottom - height)
  );
  const left = clamp(
    (pointer?.x ?? rect.left) + 14,
    Math.max(pad, bounds.left),
    Math.min(window.innerWidth - width - pad, bounds.right - width - pad)
  );
  refs.tableRowFab.style.top = `${top}px`;
  refs.tableRowFab.style.left = `${left}px`;
  refs.tableRowFab.style.display = "flex";
}

function hideTableRowFab() {
  hideInlineRowFab();
  if (refs.tableRowFab) refs.tableRowFab.style.display = "none";
  refs.hoveredRow = null;
}

function pickRowTargetFromPoint(e) {
  const target = e.target;
  if (target && !refs.tableRowFab?.contains(target)) {
    let isPinned = false;
    for (const node of refs.pinnedRowOverlays.values()) {
      if (node.contains(target)) { isPinned = true; break; }
    }
    if (!isPinned) return target;
  }

  const stack =
    typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(e.clientX, e.clientY)
      : [];

  for (const el of stack) {
    if (!el) continue;
    if (refs.tableRowFab && refs.tableRowFab.contains(el)) continue;
    let isPinned = false;
    for (const node of refs.pinnedRowOverlays.values()) {
      if (node.contains(el)) {
        isPinned = true;
        break;
      }
    }
    if (isPinned) continue;
    return el;
  }
  return target;
}

function ensureBatchBar() {
  // 先清理页面上所有残留的旧 bar（防止 SPA 导航后出现多个）
  const staleBars = document.querySelectorAll("#web2ai_batch_bar");
  if (staleBars.length > 1) {
    DEBUG && console.log(`[web2ai.BAR] ensureBatchBar found ${staleBars.length} bars in DOM! Cleaning up...`);
  }
  for (const bar of staleBars) {
    if (bar !== refs.batchBar) bar.remove();
  }
  if (refs.batchBar) {
    if (!refs.batchBar.isConnected) {
      refs.batchBar = null;
    } else {
      return;
    }
  }
  refs.batchBar = el("div", {
    id: "web2ai_batch_bar",
    "data-web2ai-ui": true,
    style: {
      position: "fixed",
      left: "12px",
      bottom: "12px",
      zIndex: TABLE_UI_Z_INDEX,
      display: "none",
      gap: "8px",
      alignItems: "center",
      pointerEvents: "auto",
      userSelect: "none",
      padding: "10px 12px",
      borderRadius: "14px",
      background: "rgba(17,24,39,0.92)",
      color: "#fff",
      border: "1px solid rgba(0,0,0,0.12)",
      boxShadow: "0 12px 32px rgba(0,0,0,0.25)",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "12px"
    }
  });

  const text = el("div", { id: "web2ai_batch_count", style: { flex: "1" } }, []);
  const selectAllBtn = el(
    "button",
    {
      id: "web2ai_batch_select_all",
      style: {
        height: "28px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.25)",
        background: "transparent",
        color: "#fff",
        padding: "0 10px",
        cursor: "pointer",
        fontSize: "12px"
      },
      onClick: () => selectAllRowsInSameGroup()
    },
    ["全选当前页"]
  );

  const clearAllBtn = el(
    "button",
    {
      id: "web2ai_batch_clear_all",
      style: {
        height: "28px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.25)",
        background: "transparent",
        color: "#fff",
        padding: "0 10px",
        cursor: "pointer",
        fontSize: "12px"
      },
      onClick: () => clearAllRowsInSameGroup()
    },
    ["取消当前页面已选"]
  );

  const multiWrap = el("div", {
    id: "web2ai_batch_multi_wrap",
    style: {
      display: "flex",
      gap: "8px",
      alignItems: "center"
    }
  });
  const multiLabel = el("div", { style: { opacity: "0.92", whiteSpace: "nowrap" } }, ["跨页选择页数"]);
  const multiInput = el("input", {
    id: "web2ai_batch_multi_pages",
    type: "number",
    value: "2",
    min: "2",
    max: "20",
    style: {
      width: "64px",
      height: "28px",
      borderRadius: "10px",
      border: "1px solid rgba(255,255,255,0.25)",
      background: "rgba(255,255,255,0.10)",
      color: "#fff",
      padding: "0 10px",
      outline: "none"
    }
  });
  const multiStartBtn = el(
    "button",
    {
      id: "web2ai_batch_multi_start",
      style: {
        height: "28px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.25)",
        background: "#fff",
        color: "#111827",
        padding: "0 10px",
        cursor: "pointer",
        fontSize: "12px"
      },
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        startMultiPageSelect();
      }
    },
    ["开始跨页选择"]
  );
  const multiStopBtn = el(
    "button",
    {
      id: "web2ai_batch_multi_stop",
      style: {
        height: "28px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.25)",
        background: "transparent",
        color: "#fff",
        padding: "0 10px",
        cursor: "pointer",
        fontSize: "12px",
        display: "none"
      },
      onClick: () => {
        if (refs.multiPageProgress) refs.multiPageProgress.stop = true;
      }
    },
    ["停止"]
  );

  multiInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      startMultiPageSelect();
    }
  });

  multiWrap.appendChild(multiLabel);
  multiWrap.appendChild(multiInput);
  multiWrap.appendChild(multiStartBtn);
  multiWrap.appendChild(multiStopBtn);

  refs.batchBar.appendChild(text);
  refs.batchBar.appendChild(selectAllBtn);
  refs.batchBar.appendChild(clearAllBtn);
  refs.batchBar.appendChild(multiWrap);
  document.documentElement.appendChild(refs.batchBar);
}

function updateBatchBar() {
  if (!STATE.launcherVisible) {
    if (refs.batchBar) refs.batchBar.style.display = "none";
    return;
  }
  // 虚拟列表快速滚动时可能有一帧没有任何数据行 DOM；批量状态不能依赖该瞬时锚点。
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) {
    refs.batchAnchorRow = findVisibleBatchAnchor(refs.batchTableId, refs.batchPageIndex);
  }
  ensureBatchBar();
  const count = refs.batchAnchorRow
    ? getAddedRowCountInGroup(refs.batchAnchorRow)
    : Array.from(refs.refToRowMeta.values()).filter((meta) =>
      meta.kind === "table-row" && meta.tableId === refs.batchTableId &&
      (refs.batchPageIndex == null || meta.pageIndex == null || meta.pageIndex === refs.batchPageIndex)
    ).length;
  if (count < 1) {
    refs.batchBar.style.display = "none";
    return;
  }
  const node = document.getElementById("web2ai_batch_count");
  if (node) node.textContent = `已加入 ${count} 行 · 是否全选当前页？`;
  const input = document.getElementById("web2ai_batch_multi_pages");
  const startBtn = document.getElementById("web2ai_batch_multi_start");
  const stopBtn = document.getElementById("web2ai_batch_multi_stop");
  const clearAllBtn = document.getElementById("web2ai_batch_clear_all");
  if (clearAllBtn) clearAllBtn.disabled = refs.multiPageRunning ? true : null;
  if (input) input.disabled = refs.multiPageRunning ? true : null;
  if (startBtn) {
    startBtn.disabled = refs.multiPageRunning ? true : null;
    startBtn.textContent =
      refs.multiPageRunning && refs.multiPageProgress
        ? `执行中${refs.multiPageProgress.done}/${refs.multiPageProgress.total}`
        : "开始跨页选择";
  }
  if (stopBtn) stopBtn.style.display = refs.multiPageRunning ? "inline-flex" : "none";
  refs.batchBar.style.display = "flex";
}

/**
 * 获取与锚点行同组的所有行（通用实现）。
 * 不依赖特定容器类型，支持各种表格结构。
 */
function getRowGroupRows(anchorRowEl) {
  if (!anchorRowEl) return [];

  // 尝试找最近的语义容器
  const containers = [
    anchorRowEl.closest("tbody"),
    anchorRowEl.closest("table"),
    anchorRowEl.closest('[role="rowgroup"]'),
    anchorRowEl.closest('[role="grid"]'),
    anchorRowEl.closest('[role="table"]'),
    anchorRowEl.closest('[role="treegrid"]'),
    anchorRowEl.closest('[role="list"]'),
  ].filter(Boolean);

  // 取最近（最内层）的容器
  let container = null;
  for (const c of containers) {
    if (!container || c.contains(container)) container = c;
  }
  if (!container) {
    container = anchorRowEl.parentElement;
    // 尝试向外扩展几层找更合适的容器
    let p = container;
    for (let i = 0; i < 3 && p; i++) {
      const candidate = p.querySelectorAll?.("tr,[role='row']");
      if (candidate && candidate.length > 1) { container = p; break; }
      p = p.parentElement;
    }
  }
  if (!container) return [];

  // 在容器内查找所有行
  const isTbodyOrTable = container.tagName === "TBODY" || container.tagName === "TABLE" ||
    container.tagName === "THEAD" || container.tagName === "TFOOT";
  let rows;
  if (isTbodyOrTable) {
    rows = container.querySelectorAll("tr");
  } else {
    rows = container.querySelectorAll("tr, [role='row']");
  }

  return Array.from(rows).filter((row) => {
    if (!row.isConnected) return false;
    if (isTableFooterOrSummaryRow(row)) return false;
    if (!isVisibleElement(row)) return false;
    // 必须有可见单元格
    const cells = getRowCells(row);
    if (!cells.length) return false;
    // 如果所有单元格都不可见，跳过
    const anyVisible = cells.some(c => isVisibleElement(c));
    return anyVisible;
  });
}

/**
 * 检测行所在容器是否为虚拟滚动（动态渲染）场景。
 * 判断依据：可见行数较少，但容器可滚动区域远大于可视区域。
 * @param {Element} rowEl - 参考行元素
 * @param {number} visibleRowCount - 当前已渲染的可见行数
 * @returns {boolean}
 */
function detectVirtualScroll(rowEl, visibleRowCount) {
  if (!rowEl || visibleRowCount >= 30) return false;
  // 沿 DOM 树向上查找有滚动的容器
  let p = rowEl.parentElement;
  for (let i = 0; i < 8 && p; i++) {
    const style = window.getComputedStyle(p);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      const ratio = p.scrollHeight / Math.max(1, p.clientHeight);
      if (ratio > 2) return true;
    }
    p = p.parentElement;
  }
  return false;
}

function selectAllRowsInSameGroup(opts = {}) {
  const keepPanelOpen = STATE.open;
  if (!refs.batchAnchorRow?.isConnected) {
    refs.batchAnchorRow = findVisibleBatchAnchor(refs.batchTableId, refs.batchPageIndex);
  }
  DEBUG && console.log(`[web2ai.BAR] selectAllRowsInSameGroup CALLED batchAnchorRow=${!!refs.batchAnchorRow} connected=${refs.batchAnchorRow?.isConnected}`);
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) { DEBUG && console.log(`[web2ai.BAR] selectAllRowsInSameGroup anchor invalid, return 0`); return 0; }
  const t0 = performance.now();
  const rows = getRowGroupRows(refs.batchAnchorRow);
  recordTableDiagnostic("batch-start", {
    visibleRows: rows.length,
    anchorIndex: refs.batchAnchorRow.getAttribute?.("data-rowindex") || "",
    tableId: getTableIdForRow(refs.batchAnchorRow)
  });
  if (DEBUG) {
    const rowDetails = rows.map((r, i) => {
      const ref = refs.selectedRowRef.get(r);
      const txt = compactOneLine(extractTableRowText(r)).slice(0, 40);
      return `[${i}] ref=${ref || "none"} text="${txt}"`;
    }).join("\n");
    DEBUG && console.log(`[web2ai] selectAllRowsInSameGroup found ${rows.length} rows:\n${rowDetails}`);
  }
  let added = 0;
  for (const rowEl of rows) {
    added += addRowElToContext(rowEl, { silent: true });
  }
  scheduleBatchSelectionReconcile();
  recordTableDiagnostic("batch-end", { visibleRows: rows.length, added });
  const elapsed = performance.now() - t0;
  DEBUG && console.log(`[web2ai] selectAllRowsInSameGroup added ${added}/${rows.length} totalTime=${elapsed.toFixed(1)}ms`);
  if (added) {
    if (IS_TOP_FRAME) {
      render();
    } else {
      try {
        chrome.runtime.sendMessage({
          type: "FORWARD_TO_TOP",
          payload: { message: { type: "RENDER_UI" } }
        }).catch(() => void 0);
      } catch {}
    }
  }
  if (added && !opts?.silent) {
    showToast(`已批量加入 ${added} 行`);
    // 检测是否为动态渲染列表，提示用户需要滚动加载更多
    if (detectVirtualScroll(refs.batchAnchorRow, rows.length)) {
      showToast("提示：当前列表为动态加载，仅选中了已渲染的行。请向下滚动加载更多数据后再次全选", 2800);
    }
  }
  updateBatchBar();
  // 批量栏可能位于子 frame，而 Chat 只渲染在顶层。全选引发站点重绘时，
  // 顶层有时会额外收到 body click；仅在操作前已展开时通知顶层保持原状态。
  if (keepPanelOpen) {
    if (IS_TOP_FRAME) {
      STATE.open = true;
      render();
    } else {
      try {
        chrome.runtime.sendMessage({
          type: "FORWARD_TO_TOP",
          payload: { message: { type: "KEEP_PANEL_OPEN_AFTER_EXTENSION_ACTION" } }
        }).catch(() => void 0);
      } catch {}
    }
  }
  return added;
}

function clearAllRowsInSameGroup(opts = {}) {
  if (!refs.batchAnchorRow?.isConnected) {
    refs.batchAnchorRow = findVisibleBatchAnchor(refs.batchTableId, refs.batchPageIndex);
  }
  DEBUG && console.log(`[web2ai.BAR] clearAllRowsInSameGroup CALLED batchAnchorRow=${!!refs.batchAnchorRow} connected=${refs.batchAnchorRow?.isConnected} batchTableRoot=${!!refs.batchTableRoot} connected=${refs.batchTableRoot?.isConnected}`);
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) { DEBUG && console.log(`[web2ai.BAR] clearAllRowsInSameGroup anchor invalid, return 0`); return 0; }
  const rows = getRowGroupRows(refs.batchAnchorRow);
  DEBUG && console.log(`[web2ai.BAR] clearAllRowsInSameGroup getRowGroupRows returned ${rows.length} rows`);
  const tableId = getTableIdForRow(refs.batchAnchorRow);
  const pageIndex = getCurrentPageIndex(refs.batchAnchorRow);
  const refs_list = Array.from(refs.refToRowMeta.entries())
    .filter(([, meta]) => meta.kind === "table-row" && meta.tableId === tableId &&
      (pageIndex == null || meta.pageIndex == null || meta.pageIndex === pageIndex))
    .map(([ref]) => ref);
  if (!refs_list.length) return 0;
  for (const ref of refs_list) {
    removeContextByRef(ref, { silent: true });
    refs.refToRowMeta.delete(ref);
  }
  refs.batchAnchorRow = rows.find((r) => isAddedRef(refs.selectedRowRef.get(r))) || null;
  if (refs.batchAnchorRow) {
    const tableEl = refs.batchAnchorRow.tagName === "TR" ? refs.batchAnchorRow.closest("table") : null;
    if (tableEl) refs.batchTableRoot = tableEl;
  } else {
    refs.batchTableRoot = null;
    refs.batchContainer = null;
  }
  if (IS_TOP_FRAME) {
    render();
  }
  updateBatchBar();
  if (!opts?.silent) showToast(`已取消 ${refs_list.length} 行`);
  return refs_list.length;
}

function isAddedRef(ref) {
  return isContextRef(ref);
}

function getAddedRowCountInGroup(anchorRowEl) {
  if (!anchorRowEl || !anchorRowEl.isConnected) return 0;
  const tableId = getTableIdForRow(anchorRowEl);
  const pageIndex = getCurrentPageIndex(anchorRowEl);
  let count = 0;
  for (const meta of refs.refToRowMeta.values()) {
    if (meta.kind !== "table-row" || meta.tableId !== tableId) continue;
    if (pageIndex != null && meta.pageIndex != null && meta.pageIndex !== pageIndex) continue;
    count++;
  }
  return count;
}

/** 当前 DOM 中可能代表业务数据行的有限集合；用于虚拟列表滚动后的绑定恢复。 */
function getRenderedTableRows() {
  return Array.from(document.querySelectorAll(
    "tbody tr, [role='rowgroup'] [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"
  )).filter((rowEl) =>
    !rowEl.closest?.("[data-web2ai-ui]") && !isTableFooterOrSummaryRow(rowEl)
  );
}

function restoreRenderedSelectionState() {
  if (!STATE.launcherVisible) return;
  for (const rowEl of getRenderedTableRows()) {
    if (!rowEl?.isConnected || isHeaderRow(rowEl)) continue;
    reconcileRecycledRow(rowEl);
    const ref = refs.selectedRowRef.get(rowEl);
    if (isAddedRef(ref)) {
      highlightRow(rowEl, true);
      ensurePinnedRowOverlay(rowEl, ref);
    } else {
      restoreSelectedRowBinding(rowEl);
    }
  }
}

/** 批量结束后框架可能还有一轮异步单元格重绘；连续两帧校验 UI 与上下文一致。 */
function scheduleBatchSelectionReconcile() {
  requestAnimationFrame(() => {
    restoreRenderedSelectionState();
    requestAnimationFrame(() => {
      restoreRenderedSelectionState();
      updateBatchBar();
    });
  });
}

function findVisibleBatchAnchor(tableId, pageIndex) {
  if (!tableId) return null;
  for (const rowEl of getRenderedTableRows()) {
    if (isHeaderRow(rowEl) || !isVisibleElement(rowEl)) continue;
    if (getTableIdForRow(rowEl) !== tableId) continue;
    const currentPage = getCurrentPageIndex(rowEl);
    if (pageIndex != null && currentPage != null && currentPage !== pageIndex) continue;
    return rowEl;
  }
  return null;
}

function pruneDisconnectedRowMappings() {
  let cleanedRows = 0, cleanedOverlays = 0;
  for (const [ref, rowEl] of refs.refToRowEl.entries()) {
    if (!rowEl || !rowEl.isConnected) { refs.refToRowEl.delete(ref); cleanedRows++; }
  }
  for (const rowEl of Array.from(refs.pinnedRowOverlays.keys())) {
    if (!rowEl || !rowEl.isConnected) { removePinnedRowOverlay(rowEl); cleanedOverlays++; }
  }
  // 清理 SPA 页面切换后的残留 batch 状态
  if (refs.batchAnchorRow && !refs.batchAnchorRow.isConnected) {
    DEBUG && console.log(`[web2ai.BAR] pruneDisconnected: clearing stale batchAnchorRow (was connected=${refs.batchAnchorRow.isConnected})`);
    const previousTableRoot = refs.batchTableRoot;
    const oldRef = refs.selectedRowRef.get(refs.batchAnchorRow);
    const oldMeta = oldRef ? refs.refToRowMeta.get(oldRef) : null;
    const tableId = refs.batchTableId || oldMeta?.tableId || getTableIdForRow(refs.batchAnchorRow);
    const pageIndex = refs.batchPageIndex ?? oldMeta?.pageIndex ?? getCurrentPageIndex(refs.batchAnchorRow);
    const replacement = findVisibleBatchAnchor(tableId, pageIndex);
    refs.batchAnchorRow = replacement;
    refs.batchTableRoot = replacement ? getStableTableRoot(replacement) : null;
    refs.batchContainer = replacement?.closest?.(DRAWER_MODAL_SELECTORS) || null;
    if (!replacement && previousTableRoot && !previousTableRoot.isConnected) {
      // SPA 切页会同时销毁整个表格根节点；这与虚拟滚动只替换行节点不同。
      refs.batchBar?.remove();
      refs.batchBar = null;
      refs.batchTableId = "";
      refs.batchPageIndex = null;
      refs.batchContainer = null;
    }
  }
  if (refs.batchTableRoot && !refs.batchTableRoot.isConnected) refs.batchTableRoot = null;
  if (refs.batchContainer && !refs.batchContainer.isConnected) refs.batchContainer = null;
  // 清理失联的 bar
  if (refs.batchBar && !refs.batchBar.isConnected) {
    DEBUG && console.log(`[web2ai.BAR] pruneDisconnected: clearing stale batchBar (was connected=${refs.batchBar.isConnected})`);
    refs.batchBar = null;
  }
  if (cleanedRows > 0 || cleanedOverlays > 0) {
    DEBUG && console.log(`[web2ai.BAR] pruneDisconnected: cleaned ${cleanedRows} rowRefs + ${cleanedOverlays} overlays`);
  }
}

function clearSelectedRowRefsInRoot(root) {
  if (!root) return;
  const rows = root.querySelectorAll?.("tbody tr, tr, [role='rowgroup'] [role='row'], [role='row']") || [];
  for (const rowEl of rows) {
    refs.selectedRowRef.delete(rowEl);
  }
}

function getTableRootForRow(rowEl) {
  if (!rowEl) return null;
  // 通用：沿 DOM 树向上找最近的有表格语义的容器
  const candidates = [
    rowEl.closest("table"),
    rowEl.closest("tbody"),
    rowEl.closest("thead"),
    rowEl.closest("tfoot"),
    rowEl.closest('[role="grid"]'),
    rowEl.closest('[role="table"]'),
    rowEl.closest('[role="treegrid"]'),
    rowEl.closest('[role="rowgroup"]'),
  ].filter(Boolean);
  // 返回最近的（最内层的）
  let best = null;
  for (const c of candidates) {
    if (!best || c.contains(best)) best = c;
  }
  return best || rowEl.parentElement || rowEl;
}

function getTableRowCount(root) {
  if (!root) return 0;
  const rows = root.querySelectorAll?.("tbody tr, tr, thead tr, tfoot tr, [role='rowgroup'] [role='row'], [role='row']") || [];
  let count = 0;
  for (const r of rows) {
    if (!r.isConnected) continue;
    const cells = getRowCells(r);
    if (cells.length) count++;
  }
  return count;
}

function dumpAllTables(label) {
  const allTables = document.querySelectorAll("table");
  DEBUG && console.log(`[web2ai] ${label}: total tables in document: ${allTables.length}`);
  allTables.forEach((tbl, idx) => {
    const visible = isVisibleElement(tbl);
    const rect = tbl.getBoundingClientRect();
    const rows = tbl.querySelectorAll("tbody tr, tr");
    const rowTexts = Array.from(rows)
      .filter(r => (r.querySelectorAll?.("td,th") || []).length > 0)
      .map((r, i) => {
        const raw = compactOneLine(r.innerText || r.textContent || "").slice(0, 50);
        return `[${i}] ${raw}`;
      });
    DEBUG && console.log(`[web2ai]   table[${idx}]: tag=${tbl.tagName} connected=${tbl.isConnected} visible=${visible} rect=${JSON.stringify({w:Math.round(rect.width),h:Math.round(rect.height)})} rows=${rowTexts.length}`);
    rowTexts.forEach(t => DEBUG && console.log(`[web2ai]     ${t}`));
  });
}

function waitForTableChange(root, prevDigest, timeoutMs = 8000, prevRowTexts, tableIndex) {
  return new Promise((resolve) => {
    const start = Date.now();
    dumpAllTables("waitForTableChange BEFORE");
    const prevTexts = prevRowTexts || getTableRowTexts(root);
    let settled = false;
    const observerTarget = refs.batchContainer?.isConnected ? refs.batchContainer : document.body;
    const finish = (changed) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(fallbackTimer);
      clearTimeout(timeoutTimer);
      if (changed) dumpAllTables("waitForTableChange CHANGED");
      resolve(changed);
    };
    const check = () => {
      if (settled) return;
      const elapsed = Date.now() - start;
      const liveRoot = (root && root.isConnected) ? root : findLiveTableByIndex(root, tableIndex);
      const currentRowTexts = getTableRowTexts(liveRoot);
      const rows = currentRowTexts.length;
      const contentChanged = prevTexts.length > 0 && currentRowTexts.length > 0 && (
        prevTexts.length !== currentRowTexts.length ||
        !prevTexts.every((t, i) => t === currentRowTexts[i])
      );
      DEBUG && console.log(`[web2ai] waitForTableChange check: root connected=${root?.isConnected} liveRoot=${liveRoot === root ? "original" : "recovered"} rows=${rows} contentChanged=${contentChanged} elapsed=${elapsed}ms`);
      if (contentChanged) finish(true);
    };
    const observer = new MutationObserver(() => check());
    observer.observe(observerTarget, { childList: true, subtree: true, characterData: true });
    // Some frameworks mutate canvas/internal state without useful records; keep a low-frequency fallback.
    const fallbackTimer = setInterval(check, 1000);
    const timeoutTimer = setTimeout(() => {
      dumpAllTables("waitForTableChange TIMEOUT");
      finish(false);
    }, timeoutMs);
    check();
  });
}

function findLiveTableByIndex(fallbackRoot, tableIndex) {
  if (tableIndex !== undefined && tableIndex >= 0) {
    const tables = document.querySelectorAll("table");
    const target = tables[tableIndex];
    if (target && target.isConnected && getTableRowCount(target) > 0) {
      return target;
    }
  }

  if (refs.batchContainer && refs.batchContainer.isConnected && tableIndex !== undefined && tableIndex >= 0) {
    const tablesInContainer = refs.batchContainer.querySelectorAll("table");
    const target = tablesInContainer[tableIndex];
    if (target && target.isConnected && getTableRowCount(target) > 0) {
      return target;
    }
  }

  if (refs.batchContainer && refs.batchContainer.isConnected) {
    let bestTable = null;
    let bestScore = -1;
    for (const tbl of refs.batchContainer.querySelectorAll("table")) {
      if (!tbl.isConnected) continue;
      if (!isVisibleElement(tbl)) continue;
      const rows = getTableRowCount(tbl);
      if (rows > bestScore) {
        bestScore = rows;
        bestTable = tbl;
      }
    }
    if (bestTable) return bestTable;
  }

  return fallbackRoot;
}

function getTableRowTexts(root) {
  if (!root) return [];
  const rows = root.querySelectorAll?.("tbody tr, tr, [role='rowgroup'] [role='row'], [role='row']") || [];
  const texts = [];
  for (const r of rows) {
    const cells = r.querySelectorAll?.("td,th,[role='cell'],[role='gridcell']") || [];
    if (!cells.length) continue;
    const raw = compactOneLine(r.innerText || r.textContent || "");
    const stripped = raw.replace(/^\d+\s*[✓✗]?\s*\|?\s*/, "").replace(/\s+/g, "").slice(0, 30);
    if (!stripped) continue;
    texts.push(stripped);
  }
  return texts;
}

function getTableContentDigest(root) {
  if (!root) return "";
  const texts = getTableRowTexts(root);
  const count = texts.length;
  const parts = texts.slice(0, 3);
  return `${count}|${parts.join("||")}`;
}

function waitForTableDataReady(root, prevDigest, timeoutMs = 12000, tableIndex) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastRows = -1;
    let stableCount = 0;
    const minWait = 2000;
    let minWaitDone = false;

    const timer = setInterval(() => {
      const elapsed = Date.now() - start;

      const liveRoot = (root && root.isConnected) ? root : findLiveTableByIndex(root, tableIndex);
      const rows = getTableRowCount(liveRoot);

      DEBUG && console.log(`[web2ai] waitForTableDataReady rows=${rows} stableCount=${stableCount} elapsed=${elapsed}ms root connected=${root?.isConnected} liveRoot=${liveRoot === root ? "original" : "recovered"}`);

      if (rows > 0 && rows === lastRows) {
        stableCount++;
        if (stableCount >= 3 && minWaitDone) {
          clearInterval(timer);
          DEBUG && console.log(`[web2ai] waitForTableDataReady resolved: ${rows} rows stable`);
          resolve(rows);
        }
      } else {
        stableCount = 0;
      }
      lastRows = rows;
      if (elapsed >= minWait) minWaitDone = true;
      if (elapsed > timeoutMs) {
        clearInterval(timer);
        DEBUG && console.log(`[web2ai] waitForTableDataReady TIMEOUT - returning ${rows} rows`);
        resolve(rows);
      }
    }, 400);
  });
}

function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView?.({ block: "center", inline: "center" });
  } catch {
    void 0;
  }
  try {
    el.focus?.();
  } catch {
    void 0;
  }
  try {
    // 分页器、抽屉按钮等站点控件经常同时监听 pointer/mouse/click。这里必须
    // 保证“只触发一次激活”，否则一次翻页可能被站点处理两次，出现跳页。
    el.click?.();
    return true;
  } catch {
    void 0;
  }
  try {
    const r = el.getBoundingClientRect?.();
    const pt = !r
      ? { x: 0, y: 0 }
      : { x: r.left + Math.min(10, Math.max(1, r.width / 2)), y: r.top + Math.min(10, Math.max(1, r.height / 2)) };
    el.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: pt.x,
      clientY: pt.y
    }));
    return true;
  } catch {
    void 0;
  }
  return false;
}

function findPaginationNextButton(anchorRowEl) {
  const start = anchorRowEl?.closest?.("table") || anchorRowEl?.closest?.("tbody") || anchorRowEl;
  const drawerContainer =
    anchorRowEl?.closest?.(DRAWER_MODAL_SELECTORS) ||
    anchorRowEl?.closest?.('[class*="drawer"i] [class*="body"i]') ||
    anchorRowEl?.closest?.('[class*="modal"i] [class*="body"i]');
  let p = start;
  for (let i = 0; i < 7 && p; i++) {
    const ant =
      p.querySelector?.(`.ant-pagination-next:not(.${ANT_PAGINATION_DISABLED}) button`) ||
      p.querySelector?.(`.ant-pagination-next:not(.${ANT_PAGINATION_DISABLED}) a`) ||
      p.querySelector?.(`.ant-pagination-next:not(.${ANT_PAGINATION_DISABLED}) .ant-pagination-item-link`) ||
      p.querySelector?.(`.ant-pagination-next button:not([disabled])`) ||
      p.querySelector?.(`.ant-pagination-next a`);
    if (ant && (!drawerContainer || drawerContainer.contains(ant))) return ant;
    const arco =
      p.querySelector?.(`.arco-pagination-item-next:not(.${ARCO_PAGINATION_DISABLED}) button`) ||
      p.querySelector?.(`.arco-pagination-item-next:not(.${ARCO_PAGINATION_DISABLED}) a`) ||
      p.querySelector?.(`.arco-pagination-next:not(.${ARCO_PAGINATION_DISABLED}) button`);
    if (arco && (!drawerContainer || drawerContainer.contains(arco))) return arco;
    const ariaNext =
      p.querySelector?.(
        "button[aria-label*='下一页']:not([disabled]):not([aria-disabled='true']),a[aria-label*='下一页']"
      ) ||
      p.querySelector?.(
        "button[aria-label*='next']:not([disabled]):not([aria-disabled='true']),a[aria-label*='next']"
      );
    if (ariaNext && (!drawerContainer || drawerContainer.contains(ariaNext))) return ariaNext;
    const nav = p.querySelector?.("[class*='pagination'],[role='navigation']");
    if (nav) {
      const btns = Array.from(nav.querySelectorAll("button,a")).filter((x) => x && isVisibleElement(x));
      const pick = btns.find((b) => {
        const t = compactOneLine(b.innerText || b.textContent || "");
        if (!t) return false;
        return t === "下一页" || t === "Next" || t === "›" || t === ">";
      });
      if (pick && (!drawerContainer || drawerContainer.contains(pick))) return pick;
    }
    p = p.parentElement;
  }

  const scope = drawerContainer || document;
  const all = Array.from(scope.querySelectorAll("button,a,[role='button']")).filter(
    (x) => x && isVisibleElement(x)
  );
  const byText =
    all.find((b) => compactOneLine(b.innerText || b.textContent || "") === "下一页") ||
    all.find((b) => compactOneLine(b.innerText || b.textContent || "") === "Next");
  if (byText) return byText;
  const byAria = all.find((b) => {
    const aria = compactOneLine(b.getAttribute?.("aria-label") || "");
    const title = compactOneLine(b.getAttribute?.("title") || "");
    return (
      aria.includes("下一页") ||
      title.includes("下一页") ||
      aria.toLowerCase().includes("next") ||
      title.toLowerCase().includes("next")
    );
  });
  if (byAria) return byAria;

  const iconNext = all.find((b) => {
    if (b.classList.contains(ANT_PAGINATION_DISABLED)) return false;
    const icon = b.querySelector?.(".anticon-right, .anticon-next, svg[data-icon='right']");
    if (!icon) return false;
    const parent = b.closest?.(".ant-pagination-next, .ant-pagination-item-next");
    return !!parent;
  });
  if (iconNext) return iconNext;

  const anyNext = all.find((b) => {
    if (b.classList.contains(ANT_PAGINATION_DISABLED)) return false;
    const parent = b.closest?.(".ant-pagination-next, .ant-pagination-item-next");
    return !!parent;
  });
  if (anyNext) return anyNext;

  const iconBtn = all.find((b) => {
    if (b.classList.contains(ANT_PAGINATION_DISABLED)) return false;
    if (b.getAttribute("aria-disabled") === "true") return false;
    const icon = b.querySelector?.(".anticon-right, svg[data-icon='right']");
    return !!icon;
  });
  return iconBtn || null;
}

function pickFirstRowInRoot(root) {
  if (!root) return null;
  const tr = root.querySelector?.("tbody tr") || root.querySelector?.("tr");
  if (tr) return tr;
  const roleRow = root.querySelector?.('[role="rowgroup"] [role="row"]') || root.querySelector?.('[role="row"]');
  return roleRow || null;
}

function findLiveTableAfterPageTurn(root, tableIndex) {
  if (!root) return root;
  if (root.isConnected && getTableRowCount(root) > 0) return root;
  const recovered = findLiveTableByIndex(root, tableIndex);
  if (recovered !== root) {
    DEBUG && console.log(`[web2ai] findLiveTableAfterPageTurn recovered via tableIndex=${tableIndex}`);
  }
  return recovered;
}

async function startMultiPageSelect() {
  DEBUG && console.log("[web2ai] startMultiPageSelect called");
  if (refs.multiPageRunning) return;
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) {
    showToast("请先在表格里加入至少两行，再使用跨页选择");
    return;
  }
  const input = document.getElementById("web2ai_batch_multi_pages");
  const raw = Number.parseInt(String(input?.value || "2"), 10);
  const total = clamp(Number.isFinite(raw) ? raw : 2, 2, 20);

  refs.multiPageRunning = true;
  refs.multiPageProgress = { stop: false, done: 0, total, added: 0 };
  updateBatchBar();

  let totalAdded = 0;
  try {
    for (let i = 0; i < total; i++) {
      if (refs.multiPageProgress.stop) break;

      if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) {
        const root = getTableRootForRow(refs.batchAnchorRow);
        refs.batchAnchorRow = pickFirstRowInRoot(root);
      }
      if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) break;

      const rowsBefore = getRowGroupRows(refs.batchAnchorRow);
      const rowsBeforeText = rowsBefore.map(r => compactOneLine(r.innerText || r.textContent || "").slice(0, 30)).join(" | ");
      DEBUG && console.log(`[web2ai] page ${i + 1} rows:`, rowsBeforeText);
      const added2 = selectAllRowsInSameGroup({ silent: true });
      totalAdded += added2;
      refs.multiPageProgress.done = i + 1;
      refs.multiPageProgress.added = totalAdded;
      updateBatchBar();
      showToast(`第 ${i + 1} 页：共 ${rowsBefore.length} 行，选中 ${added2} 行，累计 ${totalAdded} 行`);

      if (i === total - 1) break;

      const nextBtn = findPaginationNextButton(refs.batchAnchorRow);
      if (!nextBtn) {
        showToast("未找到\u201C下一页\u201D按钮，跨页已停止");
        break;
      }
      const drawerCheck =
        refs.batchAnchorRow.closest(DRAWER_MODAL_SELECTORS) ||
        refs.batchAnchorRow.closest('[class*="drawer"i] [class*="body"i]') ||
        refs.batchAnchorRow.closest('[class*="modal"i] [class*="body"i]');
      if (drawerCheck && !drawerCheck.contains(nextBtn)) {
        DEBUG && console.log(`[web2ai] nextBtn not in same drawer as batchAnchorRow, skip`);
        showToast("翻页按钮不在当前抽屉容器内，跨页已停止");
        break;
      }

      const root = (refs.batchTableRoot && refs.batchTableRoot.isConnected) ? refs.batchTableRoot : getTableRootForRow(refs.batchAnchorRow);
      if (!root || !document.body.contains(root)) {
        showToast("表格容器已断开，跨页已停止");
        break;
      }
      const tableIdx = Array.from(document.querySelectorAll("table")).indexOf(root);
      DEBUG && console.log(`[web2ai] startMultiPageSelect page ${i + 1} -> ${i + 2}, root=`, root, `tag=${root.tagName} connected=${root.isConnected} tableIndex=${tableIdx}`);
      const prevRowTexts = getTableRowTexts(root);
      const prevDigest = getTableContentDigest(root);
      DEBUG && console.log(`[web2ai] prevDigest="${prevDigest}" prevRows=${prevRowTexts.length}`);
      const clicked = clickElement(nextBtn);
      DEBUG && console.log(`[web2ai] clickElement nextBtn result=${clicked}`, nextBtn);
      if (!clicked) {
        showToast("翻页点击失败，跨页已停止");
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
      const changed = await waitForTableChange(root, prevDigest, 9000, prevRowTexts, tableIdx);
      DEBUG && console.log(`[web2ai] waitForTableChange result=${changed}`);
      if (!changed) {
        showToast("翻页后页面未更新，跨页已停止");
        break;
      }

      const rowCount = await waitForTableDataReady(root, prevDigest, 10000, tableIdx);
      DEBUG && console.log(`[web2ai] waitForTableDataReady result=${rowCount}`);
      if (!rowCount || rowCount <= 0) {
        showToast(`翻页后数据加载超时（第 ${i + 2} 页），跨页已停止`);
        break;
      }

      const liveRoot = findLiveTableAfterPageTurn(root, tableIdx);
      DEBUG && console.log(`[web2ai] after page turn: liveRoot=${liveRoot === root ? "original" : "new"}`);

      pruneDisconnectedRowMappings();
      clearSelectedRowRefsInRoot(liveRoot);
      const newRow = pickFirstRowInRoot(liveRoot);
      DEBUG && console.log(`[web2ai] pickFirstRowInRoot result=`, newRow);
      if (!newRow) {
        showToast(`翻页后未找到新行（第 ${i + 2} 页），跨页已停止`);
        break;
      }
      refs.batchAnchorRow = newRow;
      const newTableEl = newRow.tagName === "TR" ? newRow.closest("table") : null;
      if (newTableEl) {
        refs.batchTableRoot = newTableEl;
        DEBUG && console.log(`[web2ai] batchTableRoot updated, tableIndex=${Array.from(document.querySelectorAll("table")).indexOf(newTableEl)}`);
      }
      DEBUG && console.log(`[web2ai] batchAnchorRow updated, next loop i=${i + 1}`);
      updateBatchBar();
    }
  } catch (e) {
    showToast(`跨页失败：${String(e?.message ?? e)}`);
  } finally {
    refs.multiPageRunning = false;
    refs.multiPageProgress = null;
    refs.batchAnchorRow = null;
    refs.batchContainer = null;
    refs.multiPageOpen = false;
    if (refs.batchBar) refs.batchBar.style.display = "none";
  }

  if (totalAdded > 0) {
    showToast(`跨页完成：共加入 ${totalAdded} 行`);
  } else if (!refs.multiPageProgress?.stop) {
    showToast("跨页完成：没有新增可加入的数据");
  }
}

function getRowInlineAnchorCell(rowEl) {
  if (!rowEl) return null;
  const cells = rowEl.tagName === "TR"
    ? rowEl.querySelectorAll("td,th")
    : rowEl.querySelectorAll?.(
        "[role='rowheader'],[role='columnheader'],[role='cell'],[role='gridcell']"
      );
  if (!cells) return null;
  // 从第二个可见单元格开始找，跳过第一列（通常是 checkbox）
  const visible = [];
  for (const cell of cells) {
    if (cell.offsetParent !== null) visible.push(cell);
  }
  return visible[1] || visible[0] || null;
}

function getRowSelectedAnchorCell(rowEl) {
  if (!rowEl) return null;
  const cells = rowEl.tagName === "TR"
    ? rowEl.querySelectorAll("td,th")
    : rowEl.querySelectorAll?.("[role='rowheader'],[role='columnheader'],[role='cell'],[role='gridcell']");
  if (!cells) return null;
  for (const cell of cells) {
    if (cell.offsetParent !== null) return cell;
  }
  return null;
}

function initTableListeners() {
  let _showRowFabTimer = null;
  let _hideRowFabTimer = null;
  const cancelRowFabShow = () => {
    if (_showRowFabTimer) clearTimeout(_showRowFabTimer);
    _showRowFabTimer = null;
  };
  const cancelRowFabHide = () => {
    if (_hideRowFabTimer) clearTimeout(_hideRowFabTimer);
    _hideRowFabTimer = null;
  };
  const scheduleRowFabHide = () => {
    if (_hideRowFabTimer) return;
    _hideRowFabTimer = setTimeout(() => {
      _hideRowFabTimer = null;
      hideTableRowFab();
    }, 300);
  };
  document.addEventListener(
    "mousemove",
    (e) => {
      // 指针已经进入“问AI”时保持按钮原位，不再用其下方的表格行重新定位。
      if (refs.tableRowFab?.contains(e.target)) {
        cancelRowFabShow();
        cancelRowFabHide();
        return;
      }
      // 持续移动时不断延后定位；只有指针停稳后才在最后位置显示“问AI”。
      cancelRowFabShow();
      const pointer = { target: e.target, x: e.clientX, y: e.clientY, path: e.composedPath?.() };
      _showRowFabTimer = setTimeout(() => {
        _showRowFabTimer = null;
        if (!STATE.launcherVisible) {
          cancelRowFabHide();
          hideTableRowFab();
          hideInlineRowFab();
          return;
        }
        const probe = { target: pointer.target, clientX: pointer.x, clientY: pointer.y };
        const target = pickRowTargetFromPoint(probe);
        const composedPath = target === pointer.target ? pointer.path : null;
        const rowEl = findRowElementFromEventTarget(target, composedPath);
        if (!rowEl) {
          scheduleRowFabHide();
          return;
        }
        const rect = getRowAnchorRect(rowEl);
        if (!rect || rect.width === 0 || rect.height === 0) {
          scheduleRowFabHide();
          return;
        }
        cancelRowFabHide();
        showTableRowFabAt(rect, rowEl, { x: pointer.x, y: pointer.y });
      }, 100);
    },
    true
  );

  let _scrollRafPending = false;
  document.addEventListener(
    "scroll",
    () => {
      cancelRowFabShow();
      hideTableRowFab();
      if (_scrollRafPending) return;
      _scrollRafPending = true;
      // 等虚拟列表完成本帧的数据替换后，恢复新 DOM 行的选中绑定和批量锚点。
      requestAnimationFrame(() => {
        _scrollRafPending = false;
        if (!STATE.launcherVisible) return;
        restoreRenderedSelectionState();
        pruneDisconnectedRowMappings();
        for (const rowEl of refs.pinnedRowOverlays.keys()) positionPinnedRowOverlay(rowEl);
        updateBatchBar();
      });
    },
    { passive: true, capture: true }
  );
}

/** 根据 Chat 启动图标状态统一启用或停用页面表格选择 UI。 */
function setTableSelectionEnabled(enabled) {
  if (!enabled) {
    hideTableRowFab();
    hideInlineRowFab();
    if (refs.batchBar) refs.batchBar.style.display = "none";
    for (const [rowEl, overlay] of refs.pinnedRowOverlays.entries()) {
      if (overlay) overlay.style.display = "none";
      highlightRow(rowEl, false);
    }
    return;
  }

  for (const overlay of refs.pinnedRowOverlays.values()) {
    if (overlay) overlay.style.display = "flex";
  }
  restoreRenderedSelectionState();
  updateBatchBar();
}

/**
 * 幂等地清空当前 frame 的全部表格选择状态。
 * 同时处理可见/隐藏分页 DOM、虚拟行反向索引和正在运行的跨页任务；调用多次结果一致。
 */
function clearAllTableSelectionState() {
  if (refs.multiPageProgress) refs.multiPageProgress.stop = true;

  for (const rowEl of Array.from(refs.pinnedRowOverlays.keys())) {
    removePinnedRowOverlay(rowEl);
  }
  // 一些分页库会把非当前页 DOM 隐藏而非销毁；不能只依赖 pinnedRowOverlays。
  for (const rowEl of document.querySelectorAll('[data-web2ai-selected="1"]')) {
    highlightRow(rowEl, false);
  }

  // WeakMap 无法遍历，整体替换才能保证已脱离 DOM 的旧页面节点不再携带有效绑定。
  refs.selectedRowRef = new WeakMap();
  refs.refToRowEl.clear();
  refs.refToCheckbox.clear();
  refs.rowKeyToRef.clear();
  refs.refToRowKey.clear();
  refs.virtualRowPositionToRef.clear();
  refs.refToVirtualRowPosition.clear();
  refs.refToRenderedRowIdentity.clear();
  refs.renderedRowIdentityToRef.clear();
  refs.refToRowMeta.clear();

  refs.batchAnchorRow = null;
  refs.batchTableId = "";
  refs.batchPageIndex = null;
  refs.batchTableRoot = null;
  refs.batchContainer = null;
  refs.multiPageOpen = false;
  refs.multiPageRunning = false;
  refs.multiPageProgress = null;

  syncRowCheckboxState(false);
  hideTableRowFab();
  if (refs.batchBar) refs.batchBar.style.display = "none";
}

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

function dumpRowCellDetail(rowEl) {
  if (!rowEl) return "null";
  const tag = rowEl.tagName?.toLowerCase();
  const role = rowEl.getAttribute?.("role") || "";
  const info = { tag, role, cells: [] };
  const cells = getRowCells(rowEl);
  cells.forEach((c, i) => {
    info.cells.push({
      index: i,
      tag: c.tagName?.toLowerCase(),
      role: c.getAttribute?.("role") || "",
      text: (c.innerText || c.textContent || "").trim().slice(0, 100),
      colspan: c.getAttribute?.("colspan") || null,
      rowspan: c.getAttribute?.("rowspan") || null,
      scope: c.getAttribute?.("scope") || null,
      hidden: c.hidden || false,
      display: window.getComputedStyle(c).display
    });
  });
  return info;
}

export {
  getRowCells,
  getCellCount,
  isHeaderRow,
  hasHeaderCells,
  findHeaderRowAbove,
  getStableTableRoot,
  highlightRow,
  addRowElToContext,
  handleRowCheckboxChange,
  syncRowCheckboxState,
  ensureTableRowFab,
  ensureInlineRowFab,
  showInlineRowFab,
  hideInlineRowFab,
  ensurePinnedRowOverlay,
  removePinnedRowOverlay,
  positionPinnedRowOverlay,
  getRowAnchorRect,
  showTableRowFabAt,
  hideTableRowFab,
  pickRowTargetFromPoint,
  ensureBatchBar,
  updateBatchBar,
  setTableSelectionEnabled,
  clearAllTableSelectionState,
  getRowGroupRows,
  selectAllRowsInSameGroup,
  clearAllRowsInSameGroup,
  isAddedRef,
  getAddedRowCountInGroup,
  pruneDisconnectedRowMappings,
  clearSelectedRowRefsInRoot,
  getTableRootForRow,
  getTableRowCount,
  dumpAllTables,
  waitForTableChange,
  findLiveTableByIndex,
  getTableRowTexts,
  getTableContentDigest,
  waitForTableDataReady,
  clickElement,
  findPaginationNextButton,
  pickFirstRowInRoot,
  findLiveTableAfterPageTurn,
  startMultiPageSelect,
  getRowInlineAnchorCell,
  initTableListeners
};
