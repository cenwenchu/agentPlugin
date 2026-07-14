/**
 * @fileoverview 内容脚本与 Background Service Worker 之间的消息通信层。
 *
 * 职责：
 * - 将上下文数据持久化到 background（chrome.storage.session）
 * - 管理流式 AI 请求的长连接（chrome.runtime.connect）
 * - 从 background 恢复上下文（tab 刷新后重新挂载）
 */

import { uid, STATE, refs } from './state.js';
import { showToast } from './toast.js';
import { groupTableContexts } from './context-model.js';

/**
 * 打开扩展设置页。
 */
async function openOptionsPage() {
  try {
    if (chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
  } catch {
    void 0;
  }

  try {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch((e) => {
      showToast(`打开设置失败：${String(e?.message ?? e)}`);
    });
  } catch (e) {
    showToast(`打开设置失败：${String(e?.message ?? e)}`);
  }
}

/**
 * 将上下文数据保存到 background（chrome.storage.session）。
 * @param {Object} context - 上下文对象
 */
async function storeContextToBackground(context) {
  try {
    await chrome.runtime.sendMessage({ type: "STORE_CONTEXT", payload: { context } });
  } catch {
    void 0;
  }
}

/**
 * 从 background 移除指定 ref 的上下文。
 * @param {string} ref - 上下文引用标记
 */
async function removeContextInBackground(ref) {
  try {
    await chrome.runtime.sendMessage({ type: "REMOVE_CONTEXT", payload: { ref } });
  } catch {
    void 0;
  }
}

/**
 * 清除 background 中的所有上下文。
 */
async function clearContextsInBackground() {
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_CONTEXTS" });
  } catch {
    void 0;
  }
}

/**
 * 从上下文列表中解析最大 CTX 编号。
 * @param {Array<{ref:string}>} contexts
 * @returns {number}
 */
function parseMaxCtxNum(contexts) {
  return contexts
    .map((c) => String(c?.ref || ""))
    .map((r) => {
      const m = r.match(/^CTX(\d+)$/);
      return m ? Number(m[1]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
}

/**
 * 从 background 恢复上下文（用于 tab 刷新后）。
 * 重建 STATE.contexts、STATE.tableGroups 和 refToRowEl 映射。
 */
async function hydrateContextsFromBackground() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "LIST_CONTEXTS" });
    if (!resp?.ok) return;
    const contexts = Array.isArray(resp.data?.contexts) ? resp.data.contexts : [];
    STATE.nextCtxNum = Math.max(1, parseMaxCtxNum(contexts) + 1);

    for (const c of contexts) {
      if (!c?.ref) {
        c.ref = `CTX${STATE.nextCtxNum++}`;
        storeContextToBackground(c);
      }
      if (c.kind === "table-row" && c.anchorSelector) {
        try {
          const rowEl = document.querySelector(c.anchorSelector);
          if (rowEl && rowEl.isConnected) {
            refs.refToRowEl.set(c.ref, rowEl);
          }
        } catch {}
      }
    }

    STATE.contexts = contexts;
    STATE.tableGroups = groupTableContexts(contexts);
    // 动态 import 避免循环依赖（overlay.js → messaging.js）
    const { render } = await import('./overlay.js');
    render();
  } catch {
    void 0;
  }
}

/**
 * 初始化上下文计数器（不需渲染，仅同步编号）。
 */
async function initCtxCounterFromBackground() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "LIST_CONTEXTS" });
    if (!resp?.ok) return;
    const contexts = Array.isArray(resp.data?.contexts) ? resp.data.contexts : [];
    STATE.nextCtxNum = Math.max(STATE.nextCtxNum, parseMaxCtxNum(contexts) + 1);
  } catch {
    void 0;
  }
}

/**
 * 获取或创建与 background 的流式通信 port。
 * @returns {Port}
 */
function getChatPort() {
  if (refs.chatPort) return refs.chatPort;
  refs.chatPort = chrome.runtime.connect({ name: "web2ai_chat" });
  refs.chatPort.onMessage.addListener((msg) => {
    const requestId = msg?.requestId;
    if (!requestId) return;
    const handler = refs.streamHandlers.get(requestId);
    if (!handler) return;
    if (msg.type === "AI_CHAT_STREAM_CHUNK") handler.onChunk(msg.delta || "");
    if (msg.type === "AI_CHAT_STREAM_END") handler.onEnd();
    if (msg.type === "AI_CHAT_STREAM_ERROR") handler.onError(msg.error || "Unknown error");
  });
  refs.chatPort.onDisconnect.addListener(() => {
    refs.chatPort = null;
    for (const [, handler] of refs.streamHandlers) handler.onError("Disconnected");
    refs.streamHandlers.clear();
  });
  return refs.chatPort;
}

/**
 * 发起流式 AI 对话请求。
 * @param {{messages: Array, onChunk: Function}} params
 * @returns {Promise<void>}
 */
function streamChat({ messages, onChunk }) {
  const requestId = uid();
  const port = getChatPort();
  return new Promise((resolve, reject) => {
    refs.streamHandlers.set(requestId, {
      onChunk: (delta) => onChunk(delta),
      onEnd: () => {
        refs.streamHandlers.delete(requestId);
        resolve();
      },
      onError: (err) => {
        refs.streamHandlers.delete(requestId);
        reject(new Error(err));
      }
    });
    port.postMessage({ type: "AI_CHAT_STREAM", requestId, payload: { messages } });
  });
}

/**
 * 停止当前正在生成的 AI 回复（断开 port）。
 */
function stopGeneration() {
  if (refs.chatPort) {
    refs.chatPort.disconnect();
    refs.chatPort = null;
  }
  refs.streamHandlers.clear();
  refs.streamingMsgRef = null;
  STATE.pending = false;
  // 动态 import 避免循环依赖
  import('./overlay.js').then(({ render }) => render());
}

/**
 * 向 background 发送消息（安全版本，错误静默忽略）。
 * @param {Object} message
 * @returns {Promise}
 */
function sendToBackground(message) {
  try {
    return chrome.runtime.sendMessage(message).catch(() => void 0);
  } catch {
    return Promise.resolve();
  }
}

export {
  openOptionsPage,
  storeContextToBackground,
  removeContextInBackground,
  clearContextsInBackground,
  hydrateContextsFromBackground,
  initCtxCounterFromBackground,
  getChatPort,
  streamChat,
  stopGeneration,
  sendToBackground
};
