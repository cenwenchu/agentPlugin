import { DEBUG, IS_TOP_FRAME, STATE, refs } from './state.js';
import { initSelectionListeners } from './selection.js';
import { initTableListeners, highlightRow, removePinnedRowOverlay, syncRowCheckboxState, hideTableRowFab, updateBatchBar } from './table.js';
import { initHighlightStyle } from './highlight.js';
import { initOverlay, render, setOpen } from './overlay.js';
import { showToast } from './toast.js';
import { addContextSnippet, removeContextByRef, extractPageText } from './context.js';

// Set up chrome.runtime.onMessage listener
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPEN_PANEL") {
    setOpen(true);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "ADD_CONTEXT_SNIPPET") {
    DEBUG && console.log(`[web2ai] received ADD_CONTEXT_SNIPPET kind=${message.snippet?.kind} ref=${message.snippet?.ref} IS_TOP_FRAME=${IS_TOP_FRAME}`);
    addContextSnippet(message.snippet);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "REMOVE_CONTEXT_BY_REF") {
    removeContextByRef(message.ref);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "UNSELECT_ROWS_BY_REFS") {
    const refs_arr = message.refs;
    if (Array.isArray(refs_arr)) {
      syncRowCheckboxState(false);
      for (const ref of refs_arr) {
        const rowEl = refs.refToRowEl.get(ref);
        if (rowEl) {
          removePinnedRowOverlay(rowEl);
          highlightRow(rowEl, false);
          refs.selectedRowRef.delete(rowEl);
          refs.refToRowEl.delete(ref);
        }
        refs.refToCheckbox.delete(ref);
      }
      updateBatchBar();
    }
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "UNSELECT_ROW_BY_REF") {
    const ref = message.ref;
    DEBUG && console.log(`[web2ai] UNSELECT_ROW_BY_REF ref=${ref} refToRowEl.has=${refs.refToRowEl.has(ref)} refToCheckbox.has=${refs.refToCheckbox.has(ref)}`);
    syncRowCheckboxState(false);
    const rowEl = refs.refToRowEl.get(ref);
    if (rowEl) {
      removePinnedRowOverlay(rowEl);
      highlightRow(rowEl, false);
      refs.selectedRowRef.delete(rowEl);
      refs.refToRowEl.delete(ref);
    }
    refs.refToCheckbox.delete(ref);
    updateBatchBar();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "CLEAR_ROW_UI") {
    for (const rowEl of Array.from(refs.pinnedRowOverlays.keys())) {
      removePinnedRowOverlay(rowEl);
      highlightRow(rowEl, false);
      refs.selectedRowRef.delete(rowEl);
    }
    refs.refToRowEl.clear();
    refs.refToCheckbox.clear();
    refs.batchAnchorRow = null;
    refs.batchContainer = null;
    syncRowCheckboxState(false);
    hideTableRowFab();
    updateBatchBar();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "CAPTURE_PAGE") {
    const text = extractPageText();
    const snippet = {
      kind: "page",
      text,
      url: location.href,
      title: document.title
    };
    sendResponse({ ok: true, snippet });
    return;
  }

  if (message?.type === "RENDER_UI") {
    if (IS_TOP_FRAME) render();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "TOAST") {
    if (IS_TOP_FRAME) showToast(message.text);
    sendResponse({ ok: true });
    return;
  }
});

// Set up chrome.storage listeners
chrome.storage.sync
  .get(["panelMaximized"])
  .then((data) => {
    if (typeof data?.panelMaximized === "boolean") STATE.maximized = data.panelMaximized;
  })
  .catch(() => void 0);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.panelMaximized && typeof changes.panelMaximized.newValue === "boolean") {
    STATE.maximized = changes.panelMaximized.newValue;
  }
  render();
});

// Initialize
initSelectionListeners();
initTableListeners();
initHighlightStyle();
initOverlay();
