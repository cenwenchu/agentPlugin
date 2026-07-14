/**
 * @fileoverview 页面高亮定位功能。
 * 在上下文中点击"定位"时，使用 CSS Highlight API 或 fallback 方式在页面上高亮对应文本片段。
 *
 * 优先级：
 * 1. CSS Highlight API（window.CSS.highlights + window.Highlight）
 * 2. Fallback：固定定位的 div overlay
 */

import { refs, Z_INDEX } from './state.js';
import { el } from './dom.js';
import { showToast } from './toast.js';

/**
 * 注入 CSS Highlight 样式（按需创建）。
 */
function ensurePageHighlightStyle() {
  const id = "web2ai_highlight_style";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    ::highlight(web2ai) {
      background: rgba(59, 130, 246, 0.28);
      outline: 2px solid rgba(59, 130, 246, 0.65);
    }
  `;
  document.documentElement.appendChild(style);
}

/**
 * Fallback 高亮方案：用固定定位的 div 覆盖在目标区域上。
 * @param {DOMRect} rect - 目标区域
 */
function fallbackHighlightRect(rect) {
  if (!refs.fallbackHighlightBox) {
    refs.fallbackHighlightBox = el("div", {
      id: "web2ai_fallback_highlight",
      style: {
        position: "fixed",
        zIndex: Z_INDEX,
        pointerEvents: "none",
        borderRadius: "8px",
        background: "rgba(59, 130, 246, 0.18)",
        outline: "2px solid rgba(59, 130, 246, 0.65)"
      }
    });
    document.documentElement.appendChild(refs.fallbackHighlightBox);
  }
  refs.fallbackHighlightBox.style.display = "block";
  refs.fallbackHighlightBox.style.left = `${Math.max(0, rect.left - 4)}px`;
  refs.fallbackHighlightBox.style.top = `${Math.max(0, rect.top - 4)}px`;
  refs.fallbackHighlightBox.style.width = `${Math.max(0, rect.width + 8)}px`;
  refs.fallbackHighlightBox.style.height = `${Math.max(0, rect.height + 8)}px`;
  // 2.2 秒后自动隐藏
  clearTimeout(fallbackHighlightRect._t);
  fallbackHighlightRect._t = setTimeout(() => {
    refs.fallbackHighlightBox.style.display = "none";
  }, 2200);
}

/**
 * 在页面中定位并高亮指定上下文片段。
 * 通过 anchorSelector + quote 在 DOM 中查找匹配的文本节点。
 * @param {Object} context - 上下文对象，需包含 anchorSelector 和 quote
 */
function locateContext(context) {
  const selector = context?.anchorSelector;
  const quote = context?.quote;
  if (!selector || !quote) {
    showToast("这个上下文暂不支持定位");
    return;
  }
  const root = document.querySelector(selector) || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) {
    const t = walker.currentNode?.nodeValue ?? "";
    if (t && t.includes(quote)) {
      node = walker.currentNode;
      break;
    }
  }
  if (!node) {
    showToast("未能在页面中找到对应片段");
    return;
  }
  const idx = node.nodeValue.indexOf(quote);
  const range = document.createRange();
  range.setStart(node, idx);
  range.setEnd(node, idx + quote.length);

  const container = node.parentElement;
  if (container?.scrollIntoView) container.scrollIntoView({ block: "center", inline: "nearest" });

  const rect = range.getBoundingClientRect();
  if (window.CSS?.highlights && window.Highlight) {
    ensurePageHighlightStyle();
    const h = new Highlight(range);
    CSS.highlights.set("web2ai", h);
    clearTimeout(locateContext._t);
    locateContext._t = setTimeout(() => {
      try {
        CSS.highlights.delete("web2ai");
      } catch {
        void 0;
      }
    }, 2200);
  } else if (rect && rect.width && rect.height) {
    fallbackHighlightRect(rect);
  }
}

/**
 * 初始化高亮样式（目前为空操作，样式按需创建）。
 */
function initHighlightStyle() {
  // No-op: highlight styles are created on demand by ensurePageHighlightStyle
}

export { ensurePageHighlightStyle, fallbackHighlightRect, locateContext, initHighlightStyle };
