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
import { initTableListeners, highlightRow, removePinnedRowOverlay, syncRowCheckboxState, hideTableRowFab, updateBatchBar, setTableSelectionEnabled, clearAllTableSelectionState } from './table.js';
import { initHighlightStyle } from './highlight.js';
import { initOverlay, render, setOpen, refreshModelOptions, captureScreenshot, captureMultipleScreens, inspectMultiScreenScrollTarget, setMultiScreenScrollPosition, restoreMultiScreenScrollPosition, startSkillExecution } from './overlay.js';
import { showToast } from './toast.js';
import { addContextSnippet, removeContextByRef } from './context.js';
import { initSkills, reloadSkills, startSkillCreation, startSkillTablePickInFrame, cancelSkillTablePickInFrame, acceptSkillTablePickResult, resolveStoredSource, extractStoredSourceData, inspectStoredSourcePagination, collectStoredSourceData, stopStoredSourceCollection, focusStoredSource, scheduleSkillBars } from './skills.js';

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

  if (message?.type === "OPEN_SKILLS_PANEL") {
    if (!IS_TOP_FRAME) {
      sendResponse({ ok: false, error: "Skills panel must run in the top frame" });
      return;
    }
    STATE.launcherVisible = true;
    STATE.activePanelTab = "skills";
    setTableSelectionEnabled(true);
    refs.suppressPanelCloseUntil = Date.now() + 1000;
    setOpen(true);
    chrome.storage.sync.set({ launcherHidden: false, lastPanelTab: "skills" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (message?.type === "START_SKILL_CREATION") {
    if (!IS_TOP_FRAME) {
      sendResponse({ ok: false, error: "Skill creation must run in the top frame" });
      return;
    }
    STATE.launcherVisible = true;
    setTableSelectionEnabled(true);
    Promise.all([
      chrome.storage.sync.set({ launcherHidden: false }),
      startSkillCreation()
    ])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  // 右键菜单“截图（框选区域）”：顶层打开 Chat 后复用现有区域截图流程。
  if (message?.type === "START_REGION_SCREENSHOT") {
    if (!IS_TOP_FRAME) {
      sendResponse({ ok: false, error: "Region screenshot must run in the top frame" });
      return;
    }
    STATE.launcherVisible = true;
    STATE.activePanelTab = "chat";
    setTableSelectionEnabled(true);
    setOpen(true);
    Promise.all([
      chrome.storage.sync.set({ launcherHidden: false }),
      captureScreenshot({ selectRegion: true })
    ])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  // 右键菜单“多屏截图”：顶层负责截图，并协调实际可滚动的子 frame。
  if (message?.type === "START_MULTI_SCREEN_SCREENSHOT") {
    if (!IS_TOP_FRAME) {
      sendResponse({ ok: false, error: "Multi-screen capture must run in the top frame" });
      return;
    }
    STATE.launcherVisible = true;
    STATE.activePanelTab = "chat";
    setTableSelectionEnabled(true);
    setOpen(true);
    Promise.all([
      chrome.storage.sync.set({ launcherHidden: false }),
      captureMultipleScreens({ maxScreens: 5 })
    ])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "GET_MULTI_SCREEN_SCROLL_INFO") {
    sendResponse({ ok: true, data: inspectMultiScreenScrollTarget() });
    return;
  }
  if (message?.type === "SET_MULTI_SCREEN_SCROLL_POSITION") {
    setMultiScreenScrollPosition(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "RESTORE_MULTI_SCREEN_SCROLL_POSITION") {
    restoreMultiScreenScrollPosition(message)
      .then((data) => sendResponse({ ok: true, data }))
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
    clearAllTableSelectionState();
    sendResponse({ ok: true });
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

  if (message?.type === "CLOSE_PANEL_FROM_PAGE_CLICK") {
    const suppressed = Date.now() <= Number(refs.suppressPanelCloseUntil || 0);
    if (IS_TOP_FRAME && STATE.open && !STATE.skillPicking && !suppressed) setOpen(false);
    sendResponse({ ok: true }); return;
  }
  if (message?.type === "KEEP_PANEL_OPEN_AFTER_EXTENSION_ACTION") {
    if (IS_TOP_FRAME) {
      refs.suppressPanelCloseUntil = Date.now() + 800;
      if (refs.panelCloseTimer) clearTimeout(refs.panelCloseTimer);
      refs.panelCloseTimer = null;
      setOpen(true);
    }
    sendResponse({ ok: true }); return;
  }
  if (message?.type === "START_SKILL_TABLE_PICK") {
    startSkillTablePickInFrame(message.sessionId);
    sendResponse({ ok: true }); return;
  }
  if (message?.type === "CANCEL_SKILL_TABLE_PICK") {
    cancelSkillTablePickInFrame(message.sessionId);
    sendResponse({ ok: true }); return;
  }
  if (message?.type === "SKILL_TABLE_PICK_RESULT") {
    if (IS_TOP_FRAME) {
      acceptSkillTablePickResult(message.payload);
      STATE.activePanelTab = "skills";
      chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
      refs.suppressPanelCloseUntil = Date.now() + 1200;
      setOpen(true);
    }
    sendResponse({ ok: true }); return;
  }
  if (message?.type === "CHECK_SKILL_SOURCE") {
    sendResponse({ ok: true, data: resolveStoredSource(message.source) });
    return;
  }
  if (message?.type === "EXTRACT_SKILL_SOURCE_DATA") {
    sendResponse({ ok: true, data: extractStoredSourceData(message.source, message.limit || 200) });
    return;
  }
  if (message?.type === "INSPECT_SKILL_SOURCE_PAGINATION") {
    sendResponse({ ok: true, data: inspectStoredSourcePagination(message.source) });
    return;
  }
  if (message?.type === "COLLECT_SKILL_SOURCE_DATA") {
    collectStoredSourceData(message.source, message.options)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "STOP_SKILL_SOURCE_COLLECTION") {
    sendResponse({ ok: true, stopped: stopStoredSourceCollection(message.collectionId) });
    return;
  }
  if (message?.type === "SKILL_COLLECTION_PROGRESS") {
    if (IS_TOP_FRAME && STATE.skillTest?.collectionId === message.collectionId) {
      STATE.skillTest.collection = message.progress || null;
      STATE.open = true;
      refs.suppressPanelCloseUntil = Date.now() + 1000;
      render();
    }
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "SYNC_SKILL_BARS") {
    scheduleSkillBars(Array.isArray(message.skills) ? message.skills : []);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "FOCUS_SKILL_SOURCE") {
    sendResponse({ ok: true, data: focusStoredSource(message.source) });
    return;
  }
  if (message?.type === "EXECUTE_SKILL") {
    if (!IS_TOP_FRAME) {
      sendResponse({ ok: false, error: "Skill execution must run in the top frame" });
      return;
    }
    const skill = STATE.skills.find((item) => item.id === message.skillId);
    if (!skill) {
      sendResponse({ ok: false, error: "技能不存在或不属于当前页面" });
      return;
    }
    STATE.open = true;
    startSkillExecution(skill);
    sendResponse({ ok: true });
    return;
  }
});

// ========== 监听 storage 变更 ==========

chrome.storage.sync
  .get(["panelMaximized", "launcherHidden", "lastPanelTab"])
  .then((data) => {
    if (typeof data?.panelMaximized === "boolean") STATE.maximized = data.panelMaximized;
    if (data?.lastPanelTab === "chat" || data?.lastPanelTab === "skills") STATE.activePanelTab = data.lastPanelTab;
    STATE.launcherVisible = data?.launcherHidden !== true;
    setTableSelectionEnabled(STATE.launcherVisible);
    render();
  })
  .catch(() => void 0);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.web2aiSkills || changes.web2aiSkillPageNames)) reloadSkills().catch(() => void 0);
  if (areaName !== "sync") return;
  if (changes.panelMaximized && typeof changes.panelMaximized.newValue === "boolean") {
    STATE.maximized = changes.panelMaximized.newValue;
  }
  if (changes.launcherHidden) {
    STATE.launcherVisible = changes.launcherHidden.newValue !== true;
    setTableSelectionEnabled(STATE.launcherVisible);
  }
  if (changes.lastPanelTab && (changes.lastPanelTab.newValue === "chat" || changes.lastPanelTab.newValue === "skills")) {
    STATE.activePanelTab = changes.lastPanelTab.newValue;
  }
  if (changes.settings) refreshModelOptions().catch(() => void 0);
  render();
});

// ========== 初始化 ==========

const EXTENSION_UI_SELECTOR = [
  "[data-web2ai-ui]",
  "#web2ai_overlay_host",
  "#web2ai_launcher_fab",
  "#web2ai_launcher_badge",
  "#web2ai_table_row_fab",
  "#web2ai_table_row_inline_fab",
  "#web2ai_batch_bar",
  "#web2ai_screenshot_selector"
].join(", ");

/**
 * 判断点击是否发生在扩展自身 UI 内。Shadow DOM 中的点击在 document 层会
 * 重定向到 overlay host，因此同时检查 target 和 composedPath。
 */
function isExtensionUiPointerEvent(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  const ownedRoots = [
    refs.overlayHost,
    refs.launcherFab,
    refs.launcherBadge,
    refs.batchBar,
    refs.tableRowFab,
    refs.inlineRowFab,
    ...refs.pinnedRowOverlays.values()
  ].filter(Boolean);
  if (path.some((node) => ownedRoots.some((root) =>
    node === root || (node instanceof Node && root.contains?.(node))
  ))) return true;
  return path.some((node) => {
    if (!(node instanceof Element)) return false;
    if (node.matches?.(EXTENSION_UI_SELECTOR)) return true;
    return Boolean(node.closest?.(EXTENSION_UI_SELECTOR));
  });
}

// 只有完成一次明确的页面点击才收起 Chat；pointerleave/mousemove 不改变展开状态。
document.addEventListener("click", (event) => {
  const extensionUi = isExtensionUiPointerEvent(event);
  if (extensionUi) return;
  if (IS_TOP_FRAME) {
    const target = event.target instanceof Element ? event.target : null;
    const iframeOwnsClick = (target === document.body || target === document.documentElement) &&
      document.activeElement?.tagName === "IFRAME";
    // iframe 内的真实页面点击由子 frame 发送 CLOSE_PANEL_FROM_PAGE_CLICK；
    // 顶层只看到 body 的伴随点击，不能据此区分网页与 iframe 内的插件控件。
    if (iframeOwnsClick) return;
    // 捕获阶段只记录这次页面点击；等站点自身 click 处理完成后再渲染，避免
    // 在按钮更新 DOM 之前触发表格状态校验，干扰虚拟列表的节点复用判断。
    if (refs.panelCloseTimer) clearTimeout(refs.panelCloseTimer);
    refs.panelCloseTimer = setTimeout(() => {
      refs.panelCloseTimer = null;
      const suppressed = Date.now() <= Number(refs.suppressPanelCloseUntil || 0);
      if (STATE.open && !suppressed) {
        setOpen(false);
      }
    }, 300);
    return;
  }
  try {
    chrome.runtime.sendMessage({
      type: "FORWARD_TO_TOP",
      payload: { message: { type: "CLOSE_PANEL_FROM_PAGE_CLICK" } }
    }).catch(() => void 0);
  } catch {}
}, true);

initTableListeners();
initHighlightStyle();
initOverlay();
initSkills(render);

} catch (e) {
  const message = e?.message || String(e);
  if (!message.includes('Extension context invalidated') && !message.includes('context invalidated')) {
    console.error('[web2ai] Content initialization failed:', e);
  }
}
