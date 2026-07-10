import { clamp, normalizeText } from './state.js';

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

function getCssSelector(node) {
  if (!node || node.nodeType !== 1) return "";
  const elNode = node;
  if (elNode.id) return `#${CSS.escape(elNode.id)}`;

  const parts = [];
  let el = elNode;
  for (let i = 0; i < 5 && el && el.nodeType === 1 && el !== document.documentElement; i++) {
    const tag = el.tagName.toLowerCase();
    if (el.id) {
      parts.unshift(`${tag}#${CSS.escape(el.id)}`);
      break;
    }
    const parent = el.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const idx = siblings.indexOf(el) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    el = parent;
  }
  return parts.join(" > ");
}

function isVisibleElement(el) {
  if (!el || el.nodeType !== 1) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (Number(style.opacity || "1") === 0) return false;
  const rect = el.getBoundingClientRect?.();
  if (!rect || rect.width < 2 || rect.height < 2) return false;
  return true;
}

function getElementLabel(el) {
  if (!el) return "";
  const aria = (el.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim();
  if (aria) return aria;
  const title = (el.getAttribute?.("title") || "").replace(/\s+/g, " ").trim();
  if (title) return title;
  const placeholder = (el.getAttribute?.("placeholder") || "").replace(/\s+/g, " ").trim();
  if (placeholder) return placeholder;
  const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  return txt;
}

function getOverlayBoundsForElement(targetEl) {
  let bounds = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight
  };

  let el = targetEl?.nodeType === 1 ? targetEl : targetEl?.parentElement;
  while (el && el !== document.documentElement) {
    const style = window.getComputedStyle(el);
    const clipX = style.overflowX && style.overflowX !== "visible";
    const clipY = style.overflowY && style.overflowY !== "visible";
    if (clipX || clipY) {
      const r = el.getBoundingClientRect();
      if (r && r.width && r.height) {
        bounds = {
          left: Math.max(bounds.left, r.left),
          top: Math.max(bounds.top, r.top),
          right: Math.min(bounds.right, r.right),
          bottom: Math.min(bounds.bottom, r.bottom)
        };
      }
    }
    el = el.parentElement;
  }

  bounds.left = clamp(bounds.left, 0, window.innerWidth);
  bounds.right = clamp(bounds.right, 0, window.innerWidth);
  bounds.top = clamp(bounds.top, 0, window.innerHeight);
  bounds.bottom = clamp(bounds.bottom, 0, window.innerHeight);
  if (bounds.right < bounds.left) bounds.right = bounds.left;
  if (bounds.bottom < bounds.top) bounds.bottom = bounds.top;
  return bounds;
}

function findRowElementFromEventTarget(target, composedPath) {
  const path = Array.isArray(composedPath) && composedPath.length ? composedPath : null;
  const candidates = path?.length ? path : [target];
  for (const t of candidates) {
    const elNode = t?.nodeType === 1 ? t : t?.parentElement;
    if (!elNode) continue;

    const tr = elNode.closest?.("tr");
    if (tr) {
      const cells = tr.querySelectorAll("td,th");
      if (cells && cells.length) return tr;
    }

    const roleRow = elNode.closest?.('[role="row"]');
    if (roleRow) {
      const cells = roleRow.querySelectorAll(
        '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]'
      );
      if (cells && cells.length) return roleRow;
      const txt = normalizeText(roleRow.innerText || roleRow.textContent || "");
      if (txt) return roleRow;
    }
  }

  return null;
}

export { el, getCssSelector, isVisibleElement, getElementLabel, getOverlayBoundsForElement, findRowElementFromEventTarget };
