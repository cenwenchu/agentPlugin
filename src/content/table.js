import { DEBUG, IS_TOP_FRAME, STATE, COL_SEPARATOR, refs, clamp, normalizeText, compactOneLine } from './state.js';
import { el, getOverlayBoundsForElement, findRowElementFromEventTarget, isVisibleElement } from './dom.js';
import { addContextSnippet, removeContextByRef, extractTableRowText } from './context.js';
import { showToast } from './toast.js';
import { render, setOpen } from './overlay.js';

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

function addRowElToContext(rowEl, { silent } = {}) {
  if (!rowEl) return 0;
  const t0 = performance.now();
  const existing = refs.selectedRowRef.get(rowEl);
  if (isAddedRef(existing)) {
    DEBUG && console.log(`[web2ai] addRowElToContext skip already added ref=${existing}`, rowEl);
    return 0;
  }
  const text = extractTableRowText(rowEl).trim();
  if (!text) {
    DEBUG && console.log(`[web2ai] addRowElToContext skip empty text`, rowEl);
    return 0;
  }
  const textPreview = compactOneLine(text).slice(0, 60);
  DEBUG && console.log(`[web2ai] addRowElToContext adding text="${textPreview}"`, rowEl);
  const ref = `CTX${STATE.nextCtxNum++}`;
  refs.selectedRowRef.set(rowEl, ref);
  refs.refToRowEl.set(ref, rowEl);
  try {
    const cb = refs.tableRowFab?.querySelector?.("#web2ai_table_row_checkbox");
    if (cb) refs.refToCheckbox.set(ref, cb);
  } catch {}
  highlightRow(rowEl, true);
  ensurePinnedRowOverlay(rowEl, ref);
  const isHeaderRow = rowEl.querySelector("th") !== null;
  const kind = isHeaderRow ? "table-header" : "table-row";
  const cellCount = rowEl.tagName === "TR"
    ? rowEl.querySelectorAll("th,td").length
    : rowEl.getAttribute("role") === "row"
      ? rowEl.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]').length
      : 0;
  if (isHeaderRow) {
    const detail = dumpRowCellDetail(rowEl);
    console.log(`[web2ai] addRowElToContext HEADER row added: cellCount=${cellCount}`, detail);
    console.log(`[web2ai] addRowElToContext HEADER cell texts (${detail.cells.length}):`, detail.cells.map((c, i) => `[${i}] "${c.text}"`).join(", "));
  }
  if (!isHeaderRow && IS_TOP_FRAME) {
    const hasHeaderGroup = STATE.tableGroups.some(g => g.header !== null) ||
      STATE.contexts.some(c => c.kind === "table-header");
    if (!hasHeaderGroup) {
      DEBUG && console.log(`[web2ai] addRowElToContext REJECT: no header group found`);
      showToast("请先选择表格的表头行加入上下文");
      syncRowCheckboxState(false);
      highlightRow(rowEl, false);
      refs.selectedRowRef.delete(rowEl);
      refs.refToRowEl.delete(ref);
      refs.refToCheckbox.delete(ref);
      removePinnedRowOverlay(rowEl);
      return 0;
    }
    const headerGroup = STATE.tableGroups.find(g => g.header !== null);
    if (headerGroup && headerGroup.header) {
      const headerCellCount = headerGroup.header.cellCount || headerGroup.header.text.split(COL_SEPARATOR).length;
      const rowCellCount = cellCount || text.split(COL_SEPARATOR).length;
      console.log(`[web2ai] addRowElToContext colCheck: rowCellCount=${rowCellCount} headerCellCount=${headerCellCount} (cellCount=${cellCount})`);
      console.log(`[web2ai] addRowElToContext HEADER fields:`, headerGroup.header.text.split(COL_SEPARATOR).map((f, i) => `[${i}] "${f}"`).join(", "));
      console.log(`[web2ai] addRowElToContext ROW fields:`, text.split(COL_SEPARATOR).map((f, i) => `[${i}] "${f}"`).join(", "));
      // 打印行所有单元格的详细信息，便于对比表头列
      const rowDetail = dumpRowCellDetail(rowEl);
      console.log(`[web2ai] addRowElToContext ROW cell details (${cellCount} DOM cells):`, rowDetail);
      console.log(`[web2ai] addRowElToContext ROW cell texts (${rowDetail.cells.length}):`, rowDetail.cells.map((c, i) => `[${i}] "${c.text}"`).join(", "));
      if (headerGroup.header.rowEl) {
        const headerDetail = dumpRowCellDetail(headerGroup.header.rowEl);
        console.log(`[web2ai] addRowElToContext HEADER cell details:`, headerDetail);
        console.log(`[web2ai] addRowElToContext HEADER cell texts (${headerDetail.cells.length}):`, headerDetail.cells.map((c, i) => `[${i}] "${c.text}"`).join(", "));
      }
      if (rowCellCount !== headerCellCount) {
        console.log(`[web2ai] addRowElToContext REJECT: column count mismatch row=${rowCellCount} header=${headerCellCount}`);
        showToast(`当前行有 ${rowCellCount} 列，但表头有 ${headerCellCount} 列，列数不一致。如果是新表格，请先选择它的表头行`);
        syncRowCheckboxState(false);
        highlightRow(rowEl, false);
        refs.selectedRowRef.delete(rowEl);
        refs.refToRowEl.delete(ref);
        refs.refToCheckbox.delete(ref);
        removePinnedRowOverlay(rowEl);
        return 0;
      }
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
    silent: Boolean(silent)
  });

  if (!isHeaderRow) {
    refs.batchAnchorRow = rowEl;
    const parentTableEl = rowEl.tagName === "TR" ? rowEl.closest("table") : null;
    if (parentTableEl) {
      refs.batchTableRoot = parentTableEl;
      DEBUG && console.log(`[web2ai] addRowElToContext batchTableRoot set:`, parentTableEl, `tableIndex=${Array.from(document.querySelectorAll("table")).indexOf(parentTableEl)}`);
    }
    refs.batchContainer = rowEl.closest(".ant-drawer-body, .ant-modal-body, .arco-drawer-body, .arco-modal-body") ||
      rowEl.closest('[class*="drawer"i] [class*="body"i]') ||
      rowEl.closest('[class*="modal"i] [class*="body"i]') ||
      null;
    updateBatchBar();
  }
  const elapsed = performance.now() - t0;
  if (elapsed > 10) DEBUG && console.log(`[web2ai] addRowElToContext SLOW: ${elapsed.toFixed(1)}ms silent=${silent} kind=${kind} ref=${ref}`);
  return 1;
}

function handleRowCheckboxChange(checked) {
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
    style: {
      position: "fixed",
      zIndex: "2147483647",
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

  refs.tableRowFab.appendChild(
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
  input.addEventListener("change", () => {
    handleRowCheckboxChange(input.checked);
  });

  document.documentElement.appendChild(refs.tableRowFab);
}

function ensureInlineRowFab() {
  if (refs.inlineRowFab) return;
  refs.inlineRowFab = el("label", {
    id: "web2ai_table_row_inline_fab",
    title: "勾选：把该行内容加入上下文，发送给 AI",
    style: {
      position: "absolute",
      right: "6px",
      top: "50%",
      transform: "translateY(-50%)",
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
  input.addEventListener("change", () => {
    handleRowCheckboxChange(input.checked);
  });
}

function showInlineRowFab(rowEl) {
  ensureInlineRowFab();
  if (!refs.inlineRowFab) return;
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
  if (refs.pinnedRowOverlays.has(rowEl)) return;

  const isInline = rowEl.tagName === "TR";
  const inlineCell = isInline ? getRowInlineAnchorCell(rowEl) : null;
  const node = el("div", {
    style: {
      position: isInline && inlineCell ? "absolute" : "fixed",
      right: isInline && inlineCell ? "6px" : null,
      top: isInline && inlineCell ? "50%" : null,
      transform: isInline && inlineCell ? "translateY(-50%)" : null,
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      cursor: "pointer",
      userSelect: "none",
      pointerEvents: "auto"
    }
  });

  node.appendChild(
    el(
      "span",
      {
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
      },
      ["✓"]
    )
  );

  node.appendChild(
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
      ["✓"]
    )
  );

  node.addEventListener("click", (e) => {
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
  if (rowEl?.tagName === "TR") return;
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

function showTableRowFabAt(rect, rowEl) {
  if (rowEl?.tagName === "TR") {
    if (refs.tableRowFab) refs.tableRowFab.style.display = "none";
    showInlineRowFab(rowEl);
    return;
  }

  hideInlineRowFab();
  ensureTableRowFab();
  refs.hoveredRow = rowEl;
  const input = refs.tableRowFab.querySelector("#web2ai_table_row_checkbox");
  if (input) input.checked = Boolean(refs.selectedRowRef.get(rowEl));
  const pad = 6;
  const bounds = getOverlayBoundsForElement(rowEl);
  const height = 26;
  const width = 92;
  const top = clamp(
    rect.top + rect.height / 2 - 13,
    Math.max(pad, bounds.top),
    Math.min(window.innerHeight - height - pad, bounds.bottom - height - pad)
  );
  const left = clamp(
    rect.left - width,
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
  const stack =
    typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(e.clientX, e.clientY)
      : [e.target];

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
  return e.target;
}

function ensureBatchBar() {
  if (refs.batchBar) return;
  refs.batchBar = el("div", {
    id: "web2ai_batch_bar",
    style: {
      position: "fixed",
      left: "12px",
      bottom: "12px",
      zIndex: "2147483647",
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
  ensureBatchBar();
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) {
    refs.batchBar.style.display = "none";
    return;
  }
  const count = getAddedRowCountInGroup(refs.batchAnchorRow);
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

function getRowGroupRows(anchorRowEl) {
  if (!anchorRowEl) return [];
  if (anchorRowEl.tagName === "TR") {
    const tbody = anchorRowEl.closest("tbody");
    const table = anchorRowEl.closest("table");
    const container = tbody || table;
    if (!container) return [];
    return Array.from(container.querySelectorAll("tr")).filter((tr) => {
      const cells = tr.querySelectorAll("td,th");
      return cells && cells.length;
    });
  }

  const rowgroup = anchorRowEl.closest('[role="rowgroup"]');
  const grid = anchorRowEl.closest('[role="grid"],[role="table"]');
  const container = rowgroup || grid || anchorRowEl.parentElement;
  if (!container) return [];
  return Array.from(container.querySelectorAll('[role="row"]')).filter((row) => {
    const txt = normalizeText(row.innerText || row.textContent || "");
    return Boolean(txt);
  });
}

function selectAllRowsInSameGroup(opts = {}) {
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) return 0;
  const t0 = performance.now();
  const rows = getRowGroupRows(refs.batchAnchorRow);
  const rowDetails = rows.map((r, i) => {
    const ref = refs.selectedRowRef.get(r);
    const txt = compactOneLine(extractTableRowText(r)).slice(0, 40);
    return `[${i}] ref=${ref || "none"} text="${txt}"`;
  }).join("\n");
  DEBUG && console.log(`[web2ai] selectAllRowsInSameGroup found ${rows.length} rows:\n${rowDetails}`);
  let added = 0;
  for (const rowEl of rows) {
    added += addRowElToContext(rowEl, { silent: true });
  }
  const elapsed = performance.now() - t0;
  DEBUG && console.log(`[web2ai] selectAllRowsInSameGroup added ${added}/${rows.length} totalTime=${elapsed.toFixed(1)}ms`);
  if (added) {
    if (IS_TOP_FRAME) {
      render();
    } else {
      chrome.runtime.sendMessage({
        type: "FORWARD_TO_TOP",
        payload: { message: { type: "RENDER_UI" } }
      }).catch(() => void 0);
    }
  }
  if (added && !opts?.silent) showToast(`已批量加入 ${added} 行`);
  updateBatchBar();
  return added;
}

function clearAllRowsInSameGroup(opts = {}) {
  if (!refs.batchAnchorRow || !refs.batchAnchorRow.isConnected) return 0;
  const rows = getRowGroupRows(refs.batchAnchorRow);
  const refs_list = [];
  for (const rowEl of rows) {
    const ref = refs.selectedRowRef.get(rowEl);
    if (isAddedRef(ref)) refs_list.push(ref);
  }
  if (!refs_list.length) return 0;
  for (const ref of refs_list) removeContextByRef(ref, { silent: true });
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
  return typeof ref === "string" && /^CTX\d+$/.test(ref);
}

function getAddedRowCountInGroup(anchorRowEl) {
  if (!anchorRowEl || !anchorRowEl.isConnected) return 0;
  const rows = getRowGroupRows(anchorRowEl);
  let n = 0;
  for (const rowEl of rows) {
    const ref = refs.selectedRowRef.get(rowEl);
    if (isAddedRef(ref)) n++;
  }
  return n;
}

function pruneDisconnectedRowMappings() {
  for (const [ref, rowEl] of refs.refToRowEl.entries()) {
    if (!rowEl || !rowEl.isConnected) refs.refToRowEl.delete(ref);
  }
  for (const rowEl of Array.from(refs.pinnedRowOverlays.keys())) {
    if (!rowEl || !rowEl.isConnected) removePinnedRowOverlay(rowEl);
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
  if (rowEl.tagName === "TR") return rowEl.closest("table") || rowEl.closest("tbody") || rowEl;
  return (
    rowEl.closest('[role="grid"]') ||
    rowEl.closest('[role="table"]') ||
    rowEl.closest('[role="rowgroup"]') ||
    rowEl.parentElement ||
    rowEl
  );
}

function getTableRowCount(root) {
  if (!root) return 0;
  const rows = root.querySelectorAll?.("tbody tr, tr, [role='rowgroup'] [role='row'], [role='row']") || [];
  let count = 0;
  for (const r of rows) {
    const cells = r.querySelectorAll?.("td,th,[role='cell'],[role='gridcell']") || [];
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

    const timer = setInterval(() => {
      const elapsed = Date.now() - start;

      const liveRoot = (root && root.isConnected) ? root : findLiveTableByIndex(root, tableIndex);
      const currentRowTexts = getTableRowTexts(liveRoot);
      const rows = currentRowTexts.length;

      const contentChanged = prevTexts.length > 0 && currentRowTexts.length > 0 && (
        prevTexts.length !== currentRowTexts.length ||
        !prevTexts.every((t, i) => t === currentRowTexts[i])
      );

      DEBUG && console.log(`[web2ai] waitForTableChange check: root connected=${root?.isConnected} liveRoot=${liveRoot === root ? "original" : "recovered"} rows=${rows} contentChanged=${contentChanged} elapsed=${elapsed}ms`);

      if (elapsed % 3000 < 50) {
        dumpAllTables(`waitForTableChange DURING elapsed=${elapsed}ms`);
      }

      if (contentChanged) {
        dumpAllTables("waitForTableChange CHANGED");
        clearInterval(timer);
        resolve(true);
      } else if (elapsed > timeoutMs) {
        dumpAllTables("waitForTableChange TIMEOUT");
        clearInterval(timer);
        resolve(false);
      }
    }, 300);
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
  const pt = (() => {
    const r = el.getBoundingClientRect?.();
    if (!r) return { x: 0, y: 0 };
    return { x: r.left + Math.min(10, Math.max(1, r.width / 2)), y: r.top + Math.min(10, Math.max(1, r.height / 2)) };
  })();
  const common = { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y };
  try {
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent("pointerdown", common));
  } catch {
    void 0;
  }
  try {
    el.dispatchEvent(new MouseEvent("mousedown", common));
  } catch {
    void 0;
  }
  try {
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent("pointerup", common));
  } catch {
    void 0;
  }
  try {
    el.dispatchEvent(new MouseEvent("mouseup", common));
  } catch {
    void 0;
  }
  try {
    el.click?.();
  } catch {
    void 0;
  }
  try {
    el.dispatchEvent(new MouseEvent("click", common));
  } catch {
    void 0;
  }
  return true;
}

function findPaginationNextButton(anchorRowEl) {
  const start = anchorRowEl?.closest?.("table") || anchorRowEl?.closest?.("tbody") || anchorRowEl;
  const drawerContainer =
    anchorRowEl?.closest?.(".ant-drawer-body, .ant-modal-body, .arco-drawer-body, .arco-modal-body") ||
    anchorRowEl?.closest?.('[class*="drawer"i] [class*="body"i]') ||
    anchorRowEl?.closest?.('[class*="modal"i] [class*="body"i]');
  let p = start;
  for (let i = 0; i < 7 && p; i++) {
    const ant =
      p.querySelector?.(".ant-pagination-next:not(.ant-pagination-disabled) button") ||
      p.querySelector?.(".ant-pagination-next:not(.ant-pagination-disabled) a") ||
      p.querySelector?.(".ant-pagination-next:not(.ant-pagination-disabled) .ant-pagination-item-link") ||
      p.querySelector?.(".ant-pagination-next button:not([disabled])") ||
      p.querySelector?.(".ant-pagination-next a");
    if (ant && (!drawerContainer || drawerContainer.contains(ant))) return ant;
    const arco =
      p.querySelector?.(".arco-pagination-item-next:not(.arco-pagination-item-disabled) button") ||
      p.querySelector?.(".arco-pagination-item-next:not(.arco-pagination-item-disabled) a") ||
      p.querySelector?.(".arco-pagination-next:not(.arco-pagination-item-disabled) button");
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
    if (b.classList.contains("ant-pagination-disabled")) return false;
    const icon = b.querySelector?.(".anticon-right, .anticon-next, svg[data-icon='right']");
    if (!icon) return false;
    const parent = b.closest?.(".ant-pagination-next, .ant-pagination-item-next");
    return !!parent;
  });
  if (iconNext) return iconNext;

  const anyNext = all.find((b) => {
    if (b.classList.contains("ant-pagination-disabled")) return false;
    const parent = b.closest?.(".ant-pagination-next, .ant-pagination-item-next");
    return !!parent;
  });
  if (anyNext) return anyNext;

  const iconBtn = all.find((b) => {
    if (b.classList.contains("ant-pagination-disabled")) return false;
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
        refs.batchAnchorRow.closest(".ant-drawer-body, .ant-modal-body, .arco-drawer-body, .arco-modal-body") ||
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
    setOpen(true);
  } else if (!refs.multiPageProgress?.stop) {
    showToast("跨页完成：没有新增可加入的数据");
  }
}

function getRowInlineAnchorCell(rowEl) {
  if (!rowEl) return null;
  if (rowEl.tagName === "TR") return rowEl.querySelector("td,th");
  return rowEl.querySelector?.(
    "[role='rowheader'],[role='columnheader'],[role='cell'],[role='gridcell']"
  );
}

function initTableListeners() {
  let _rafPending = false;
  document.addEventListener(
    "mousemove",
    (e) => {
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => {
        _rafPending = false;
        const target = pickRowTargetFromPoint(e);
        const composedPath = target === e.target ? e.composedPath?.() : null;
        const rowEl = findRowElementFromEventTarget(target, composedPath);
        if (!rowEl) {
          hideTableRowFab();
          return;
        }
        const rect = getRowAnchorRect(rowEl);
        if (!rect || rect.width === 0 || rect.height === 0) {
          hideTableRowFab();
          return;
        }
        showTableRowFabAt(rect, rowEl);
      });
    },
    true
  );

  document.addEventListener(
    "scroll",
    () => {
      hideTableRowFab();
      for (const rowEl of refs.pinnedRowOverlays.keys()) positionPinnedRowOverlay(rowEl);
    },
    true
  );
}

function dumpRowCellDetail(rowEl) {
  if (!rowEl) return "null";
  const tag = rowEl.tagName?.toLowerCase();
  const role = rowEl.getAttribute?.("role") || "";
  const info = { tag, role, cells: [] };
  if (tag === "tr") {
    const cells = rowEl.querySelectorAll("th,td");
    cells.forEach((c, i) => {
      info.cells.push({
        index: i,
        tag: c.tagName?.toLowerCase(),
        text: (c.innerText || c.textContent || "").trim().slice(0, 100),
        colspan: c.getAttribute?.("colspan") || null,
        rowspan: c.getAttribute?.("rowspan") || null,
        hidden: c.hidden || false,
        display: window.getComputedStyle(c).display
      });
    });
  } else if (role === "row") {
    const cells = rowEl.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]');
    cells.forEach((c, i) => {
      info.cells.push({
        index: i,
        role: c.getAttribute?.("role") || "",
        text: (c.innerText || c.textContent || "").trim().slice(0, 100),
        colspan: c.getAttribute?.("colspan") || null,
        rowspan: c.getAttribute?.("rowspan") || null,
        hidden: c.hidden || false,
        display: window.getComputedStyle(c).display
      });
    });
  }
  return info;
}

export {
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
