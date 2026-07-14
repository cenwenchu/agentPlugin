/**
 * @fileoverview 文本选中处理。
 * 监听 selectionchange 事件，在选中文本附近显示浮动"问AI"按钮。
 * 用户点击后将选中内容添加到 AI 上下文中。
 */

import { DEBUG, refs, clamp, normalizeText, Z_INDEX } from './state.js';
import { el, getCssSelector } from './dom.js';
import { addContextSnippet } from './context.js';

/**
 * 获取当前选中的文本（规范化后）。
 * @returns {string}
 */
function getSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  return normalizeText(sel.toString());
}

/**
 * 获取当前选中区域的边界矩形。
 * @returns {DOMRect|null}
 */
function getSelectionRect() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}

/**
 * 获取选中起始位置的祖先元素。
 * @returns {Element|null}
 */
function getSelectionAnchorElement() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  return node?.nodeType === 1 ? node : node?.parentElement ?? null;
}

/**
 * 获取选中区域的行号信息（仅在 pre/code 容器内有效）。
 * @returns {{anchorSelector: string, startLine: number, endLine: number}|null}
 */
function getSelectionLineInfo() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const anchor = getSelectionAnchorElement();
  const container = anchor?.closest?.("pre,code");
  if (!container) return null;
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const startRange = document.createRange();
  startRange.selectNodeContents(container);
  startRange.setEnd(range.startContainer, range.startOffset);
  const startText = startRange.toString();
  const startLine = startText.split("\n").length;

  const endRange = document.createRange();
  endRange.selectNodeContents(container);
  endRange.setEnd(range.endContainer, range.endOffset);
  const endText = endRange.toString();
  const endLine = endText.split("\n").length;

  return {
    anchorSelector: getCssSelector(container),
    startLine: Math.max(1, startLine),
    endLine: Math.max(1, endLine)
  };
}

/**
 * 确保"问AI"浮动按钮已创建（懒初始化）。
 */
function ensureSelectionFab() {
  if (refs.selectionFab) return;
  refs.selectionFab = el("button", {
    id: "web2ai_selection_fab",
    style: {
      position: "fixed",
      zIndex: Z_INDEX,
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      padding: "8px 10px",
      borderRadius: "999px",
      border: "1px solid rgba(0,0,0,0.12)",
      background: "rgba(17,24,39,0.92)",
      color: "#fff",
      fontSize: "12px",
      lineHeight: "1",
      boxShadow: "0 12px 32px rgba(0,0,0,0.28)",
      cursor: "pointer",
      pointerEvents: "auto",
      userSelect: "none"
    },
    onPointerdown: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const snap = refs.lastSelectionSnapshot;
      if (!snap?.text) return;
      addContextSnippet({
        kind: "selection",
        text: snap.text,
        url: location.href,
        title: document.title,
        anchorSelector: snap.anchorSelector,
        quote: snap.quote,
        lineInfo: snap.lineInfo
      });
      hideSelectionFab();
    }
  });
  refs.selectionFab.textContent = "问AI";
  document.documentElement.appendChild(refs.selectionFab);
}

/**
 * 显示选中文本的浮动按钮。
 * @param {{text:string, rect:DOMRect, anchorSelector:string, quote:string, lineInfo:Object}} snapshot
 */
function showSelectionFab(snapshot) {
  ensureSelectionFab();
  refs.lastSelectionSnapshot = snapshot;
  const rect = snapshot?.rect;
  if (!rect) {
    hideSelectionFab();
    return;
  }
  const w = 64;
  const h = 32;
  const pad = 8;
  const top = clamp(rect.top - h - 8, pad, window.innerHeight - h - pad);
  const left = clamp(rect.right - w, pad, window.innerWidth - w - pad);
  refs.selectionFab.style.top = `${top}px`;
  refs.selectionFab.style.left = `${left}px`;
  refs.selectionFab.style.display = "inline-flex";
}

/**
 * 隐藏选中文本的浮动按钮。
 */
function hideSelectionFab() {
  if (!refs.selectionFab) return;
  refs.selectionFab.style.display = "none";
  refs.lastSelectionSnapshot = null;
}

/**
 * 初始化选中文本监听器。
 * - 使用 debounce（100ms）监听 selectionchange
 * - 滚动/缩放时自动隐藏
 */
function initSelectionListeners() {
  let selectionDebounceTimer = null;
  document.addEventListener(
    "selectionchange",
    () => {
      if (selectionDebounceTimer) return;
      selectionDebounceTimer = setTimeout(() => {
        selectionDebounceTimer = null;
        const text = getSelectionText();
        if (!text) {
          hideSelectionFab();
          return;
        }
        const rect = getSelectionRect();
        if (!rect) {
          hideSelectionFab();
          return;
        }
        const anchorEl = getSelectionAnchorElement();
        // 避免在 overlay 内的选中也触发外部按钮
        if (refs.overlayHost && anchorEl && refs.overlayHost.contains(anchorEl)) {
          hideSelectionFab();
          return;
        }
        const lineInfo = getSelectionLineInfo();
        const anchorSelector = lineInfo?.anchorSelector || getCssSelector(anchorEl);
        const quote = normalizeText(text).slice(0, 80);
        showSelectionFab({ text, rect, anchorSelector, quote, lineInfo });
      }, 100);
    },
    true
  );

  let scrollRafPending = false;
  const onScroll = () => {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      hideSelectionFab();
    });
  };
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onScroll, { passive: true, capture: true });
}

export {
  getSelectionText,
  getSelectionRect,
  getSelectionAnchorElement,
  getSelectionLineInfo,
  ensureSelectionFab,
  showSelectionFab,
  hideSelectionFab,
  initSelectionListeners
};
