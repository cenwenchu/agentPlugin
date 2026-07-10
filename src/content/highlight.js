import { refs, Z_INDEX } from './state.js';
import { el } from './dom.js';
import { showToast } from './toast.js';

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
  clearTimeout(fallbackHighlightRect._t);
  fallbackHighlightRect._t = setTimeout(() => {
    refs.fallbackHighlightBox.style.display = "none";
  }, 2200);
}

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

function initHighlightStyle() {
  // No-op: highlight styles are created on demand by ensurePageHighlightStyle
}

export { ensurePageHighlightStyle, fallbackHighlightRect, locateContext, initHighlightStyle };
