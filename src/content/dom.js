/**
 * @fileoverview DOM 工具函数。
 * 提供简化的元素创建、CSS 选择器生成、可见性判断等辅助方法。
 */

import { clamp, normalizeText } from './state.js';

/**
 * 声明式 DOM 元素创建。
 * @param {string} tag - HTML 标签名
 * @param {Object} [attrs={}] - 属性对象：
 *   - `style`: 样式对象（赋值到 node.style）
 *   - `onXxx`: 事件处理器（如 onClick, onSubmit，自动 addEventListener）
 *   - 其他: 作为 HTML attribute 设置（true → 空属性，false/null → 跳过）
 * @param {Array<string|Node>} [children=[]] - 子节点：字符串会转为 TextNode
 * @returns {HTMLElement}
 */
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

/**
 * 生成元素的可复用 CSS 选择器（最多向上追溯 5 层）。
 * @param {Element} node - 目标元素
 * @returns {string} CSS 选择器字符串（如 `#header` 或 `div:nth-of-type(2) > span`）
 */
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

/**
 * 判断元素是否可见（display !== none, visibility !== hidden, opacity > 0, 尺寸 ≥ 2px）。
 * @param {Element} el - 目标元素
 * @returns {boolean}
 */
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

/**
 * 获取元素的可读标签（优先级：aria-label > title > placeholder > textContent）。
 * @param {Element} el - 目标元素
 * @returns {string}
 */
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

/**
 * 计算元素的可用布局边界（沿 DOM 树向上查找 overflow 容器）。
 * 用于将 FAB 按钮限制在目标元素的可见区域内。
 * @param {Element} targetEl - 目标元素
 * @returns {{left:number, top:number, right:number, bottom:number}}
 */
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

/**
 * 从事件目标中查找最近的表格行元素。
 * 支持 `<tr>` 标签和 `[role="row"]`。
 * @param {EventTarget} target - 事件目标
 * @param {Array<EventTarget>} [composedPath] - 事件传播路径
 * @returns {Element|null}
 */
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
