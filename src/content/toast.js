/**
 * @fileoverview Toast 提示组件。
 * 默认在页面底部居中显示错误/提示信息，重要结果也可显示在屏幕中央。
 * 如果在 iframe 中调用，会转发到 top frame 显示。
 */

import { DEBUG, IS_TOP_FRAME, refs, Z_INDEX } from './state.js';
import { el } from './dom.js';

/**
 * 显示一条 toast 提示。
 * - 多消息自动排队，逐条展示
 * - iframe 中会通过 chrome.runtime.sendMessage 转发到 top frame
 * @param {string} message - 提示内容
 * @param {number} [duration=1500] - 每条消息的展示时长（毫秒）
 * @param {{ position?: "bottom" | "center" }} [options] - 提示位置
 */
function showToast(message, duration = 1500, options = {}) {
  DEBUG && console.log(`[web2ai] showToast called: "${String(message ?? "").slice(0, 60)}" IS_TOP_FRAME=${IS_TOP_FRAME}`);
  // 如果在 iframe 中，转发到 top frame 显示
  if (!IS_TOP_FRAME) {
    try {
      chrome.runtime.sendMessage({
        type: "BROADCAST_TO_TAB",
        payload: { message: { type: "TOAST", text: String(message ?? ""), position: options.position } }
      }).catch(() => void 0);
    } catch {}
    return;
  }
  refs.toastQueue.push({ message: String(message ?? ""), duration, position: options.position || "bottom" });
  if (refs.toastTimer) {
    DEBUG && console.log(`[web2ai] showToast: timer already active, queued. queue.length=${refs.toastQueue.length}`);
    return;
  }
  const id = "web2ai_toast";
  let node = document.getElementById(id);
  if (!node) {
    node = el("div", {
      id,
      style: {
        position: "fixed",
        left: "50%",
        bottom: "18px",
        transform: "translateX(-50%)",
        zIndex: Z_INDEX,
        background: "rgba(220,38,38,0.95)",
        color: "white",
        padding: "14px 20px",
        borderRadius: "14px",
        fontSize: "15px",
        fontWeight: "600",
        lineHeight: "1.4",
        maxWidth: "85vw",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
        border: "1px solid rgba(255,255,255,0.15)",
        // Toast 只承担提示作用，不能遮挡页面或底部批量操作栏的点击。
        pointerEvents: "none",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }
    });
    document.documentElement.appendChild(node);
    DEBUG && console.log(`[web2ai] showToast: created toast node`);
  }
  /** 从队列中取下一条并展示 */
  const showNext = () => {
    if (!refs.toastQueue.length) { refs.toastTimer = null; node.style.display = "none"; DEBUG && console.log(`[web2ai] showToast: queue empty, hidden`); return; }
    const item = refs.toastQueue.shift();
    const msg = typeof item === "string" ? item : item.message;
    const itemDuration = typeof item === "string" ? duration : item.duration;
    const position = typeof item === "string" ? "bottom" : item.position;
    DEBUG && console.log(`[web2ai] showToast: displaying "${msg.slice(0, 60)}" queue.length=${refs.toastQueue.length}`);
    node.textContent = msg;
    node.style.top = position === "center" ? "50%" : "auto";
    node.style.bottom = position === "center" ? "auto" : "18px";
    node.style.transform = position === "center" ? "translate(-50%, -50%)" : "translateX(-50%)";
    node.style.display = "block";
    refs.toastTimer = setTimeout(showNext, itemDuration);
  };
  showNext();
}

export { showToast };
