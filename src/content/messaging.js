/**
 * @fileoverview 内容脚本与 Background Service Worker 之间的消息通信层。
 *
 * 职责：
 * - 管理流式 AI 请求的长连接（chrome.runtime.connect）
 * - 向 background 请求设置、消息转发等非流式操作
 *
 * 上下文和对话只保存在顶层 content script 内存中，页面刷新后清空。
 */

import { uid, STATE, refs } from './state.js';
import { showToast } from './toast.js';

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
  getChatPort,
  streamChat,
  stopGeneration,
  sendToBackground
};
