/**
 * @fileoverview 内容脚本主入口。
 * 当 content_script 注入到页面后在所有 frame 中运行。
 *
 * 职责：
 * - 注册 chrome.runtime.onMessage 监听器，处理来自 background 的消息
 * - 监听 chrome.storage 变更（如面板最大化状态）
 * - 初始化表格监听器、高亮样式和 overlay
 *
 * 注意：整个初始化代码被 try/catch 包裹，
 * 扩展上下文失效时静默退出（不过 loader.js 已做了同样的保护）。
 */

import { DEBUG, IS_TOP_FRAME, STATE, refs } from './state.js';
import { initTableListeners, highlightRow, removePinnedRowOverlay, syncRowCheckboxState, hideTableRowFab, updateBatchBar, setTableSelectionEnabled } from './table.js';
import { initHighlightStyle } from './highlight.js';
import { initOverlay, render, setOpen } from './overlay.js';
import { showToast } from './toast.js';
import { addContextSnippet, removeContextByRef, extractPageText } from './context.js';

// Guard: bail out if extension context was invalidated (extension reloaded/removed)
try {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || !chrome.runtime.onMessage) {
    throw new Error('Extension context invalidated');
  }

// ========== 消息监听 ==========

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 打开面板
  if (message?.type === "OPEN_PANEL") {
    STATE.launcherVisible = true;
    setTableSelectionEnabled(true);
    setOpen(true);
    chrome.storage.sync.set({ launcherHidden: false })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  // 用户点击浏览器工具栏中的扩展图标后，恢复页面 Chat 图标
  if (message?.type === "SHOW_LAUNCHER") {
    // launcherHidden 是跨 frame 的功能总开关；所有 frame 会通过 storage.onChanged
    // 同步恢复表格交互，只有 top frame 负责渲染 Chat 图标。
    STATE.launcherVisible = true;
    setTableSelectionEnabled(true);
    render();
    // 等持久化完成后再回复 background，避免快速“关闭→恢复”时旧写入覆盖新状态。
    chrome.storage.sync.set({ launcherHidden: false })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  // 添加上下文片段
  if (message?.type === "ADD_CONTEXT_SNIPPET") {
    DEBUG && console.log(`[web2ai] received ADD_CONTEXT_SNIPPET kind=${message.snippet?.kind} ref=${message.snippet?.ref} IS_TOP_FRAME=${IS_TOP_FRAME}`);
    addContextSnippet(message.snippet);
    if (!STATE.open) { STATE.open = true; render(); }
    sendResponse({ ok: true });
    return;
  }

  // 按 ref 移除上下文
  if (message?.type === "REMOVE_CONTEXT_BY_REF") {
    removeContextByRef(message.ref);
    sendResponse({ ok: true });
    return;
  }

  // 批量取消选中行（通过 ref 列表）
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
        const rowKey = refs.refToRowKey.get(ref);
        if (rowKey) refs.rowKeyToRef.delete(rowKey);
        refs.refToRowKey.delete(ref);
        const virtualPosition = refs.refToVirtualRowPosition.get(ref);
        if (virtualPosition) refs.virtualRowPositionToRef.delete(virtualPosition);
        refs.refToVirtualRowPosition.delete(ref);
        const renderedIdentity = refs.refToRenderedRowIdentity.get(ref);
        if (renderedIdentity && refs.renderedRowIdentityToRef.get(renderedIdentity) === ref) {
          refs.renderedRowIdentityToRef.delete(renderedIdentity);
        }
        refs.refToRenderedRowIdentity.delete(ref);
        refs.refToRowMeta.delete(ref);
      }
      updateBatchBar();
    }
    sendResponse({ ok: true });
    return;
  }

  // 取消选中单行（通过 ref）
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
    const rowKey = refs.refToRowKey.get(ref);
    if (rowKey) refs.rowKeyToRef.delete(rowKey);
    refs.refToRowKey.delete(ref);
    const virtualPosition = refs.refToVirtualRowPosition.get(ref);
    if (virtualPosition) refs.virtualRowPositionToRef.delete(virtualPosition);
    refs.refToVirtualRowPosition.delete(ref);
    const renderedIdentity = refs.refToRenderedRowIdentity.get(ref);
    if (renderedIdentity && refs.renderedRowIdentityToRef.get(renderedIdentity) === ref) {
      refs.renderedRowIdentityToRef.delete(renderedIdentity);
    }
    refs.refToRenderedRowIdentity.delete(ref);
    refs.refToRowMeta.delete(ref);
    updateBatchBar();
    sendResponse({ ok: true });
    return;
  }

  // 清除所有行的 UI 状态
  if (message?.type === "CLEAR_ROW_UI") {
    for (const rowEl of Array.from(refs.pinnedRowOverlays.keys())) {
      removePinnedRowOverlay(rowEl);
      highlightRow(rowEl, false);
      refs.selectedRowRef.delete(rowEl);
    }
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
    refs.batchTableRoot = null;
    refs.batchContainer = null;
    syncRowCheckboxState(false);
    hideTableRowFab();
    updateBatchBar();
    sendResponse({ ok: true });
    return;
  }

  // 捕获当前页面文本
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

  // 渲染 UI
  if (message?.type === "RENDER_UI") {
    if (IS_TOP_FRAME) render();
    sendResponse({ ok: true });
    return;
  }

  // 显示 Toast
  if (message?.type === "TOAST") {
    if (IS_TOP_FRAME) showToast(message.text);
    sendResponse({ ok: true });
    return;
  }
});

// ========== 监听 storage 变更 ==========

chrome.storage.sync
  .get(["panelMaximized", "launcherHidden"])
  .then((data) => {
    if (typeof data?.panelMaximized === "boolean") STATE.maximized = data.panelMaximized;
    STATE.launcherVisible = data?.launcherHidden !== true;
    setTableSelectionEnabled(STATE.launcherVisible);
    render();
  })
  .catch(() => void 0);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.panelMaximized && typeof changes.panelMaximized.newValue === "boolean") {
    STATE.maximized = changes.panelMaximized.newValue;
  }
  if (changes.launcherHidden) {
    STATE.launcherVisible = changes.launcherHidden.newValue !== true;
    setTableSelectionEnabled(STATE.launcherVisible);
  }
  render();
});

// ========== 初始化 ==========

initTableListeners();
initHighlightStyle();
initOverlay();

} catch (e) {
  const message = e?.message || String(e);
  if (!message.includes('Extension context invalidated') && !message.includes('context invalidated')) {
    console.error('[web2ai] Content initialization failed:', e);
  }
}
