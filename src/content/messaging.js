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
  const port = chrome.runtime.connect({ name: "web2ai_chat" });
  refs.chatPort = port;
  port.onMessage.addListener((msg) => {
    const requestId = msg?.requestId;
    if (!requestId) return;
    const handler = refs.streamHandlers.get(requestId);
    if (!handler) return;
    if (msg.type === "AI_CHAT_STREAM_CHUNK") handler.onChunk(msg.delta || "");
    if (msg.type === "AI_CHAT_STREAM_END") handler.onEnd();
    if (msg.type === "AI_CHAT_STREAM_ERROR") handler.onError({
      code: msg.code || "AI_STREAM_ERROR",
      message: msg.error || "Unknown error"
    });
  });
  port.onDisconnect.addListener(() => {
    const runtimeMessage = chrome.runtime.lastError?.message || "";
    // 旧 port 的延迟 disconnect 不能清空刚刚重建的新连接。
    if (refs.chatPort === port) refs.chatPort = null;
    for (const [requestId, handler] of refs.streamHandlers) {
      if (handler.port !== port) continue;
      handler.onError({
        code: "STREAM_DISCONNECTED",
        message: runtimeMessage.includes("context invalidated")
          ? "插件已更新，请刷新当前网页后重试"
          : `与模型的流式连接意外中断${runtimeMessage ? `：${runtimeMessage}` : ""}`
      });
      refs.streamHandlers.delete(requestId);
    }
  });
  return port;
}

/**
 * 发起流式 AI 对话请求。
 * @param {{messages: Array, onChunk: Function}} params
 * @returns {Promise<void>}
 */
function streamChatOnce({ messages, onChunk, debugLabel = "chat" }) {
  const requestId = uid();
  const port = getChatPort();
  return new Promise((resolve, reject) => {
    // Chrome MV3 会在约 30 秒没有扩展事件时回收 Service Worker。部分模型在
    // 首 token 前思考较久，因此请求期间定时发送无业务数据的 port 心跳。
    const heartbeat = setInterval(() => {
      try { port.postMessage({ type: "AI_CHAT_STREAM_HEARTBEAT", requestId }); } catch { void 0; }
    }, 10000);
    const clearHeartbeat = () => clearInterval(heartbeat);
    refs.streamHandlers.set(requestId, {
      port,
      onChunk: (delta) => onChunk(delta),
      onEnd: () => {
        clearHeartbeat();
        refs.streamHandlers.delete(requestId);
        resolve();
      },
      onError: (err) => {
        clearHeartbeat();
        refs.streamHandlers.delete(requestId);
        const error = new Error(typeof err === "object" ? err.message : err);
        if (typeof err === "object" && err?.code) error.code = err.code;
        reject(error);
      }
    });
    try {
    port.postMessage({ type: "AI_CHAT_STREAM", requestId, payload: { messages, modelId: STATE.activeModelId, debugLabel } });
    } catch (error) {
      clearHeartbeat();
      refs.streamHandlers.delete(requestId);
      refs.chatPort = null;
      const wrapped = new Error(error?.message || "与模型的流式连接意外中断");
      wrapped.code = "STREAM_DISCONNECTED";
      reject(wrapped);
    }
  });
}

async function streamChat({ messages, onChunk, debugLabel = "chat" }) {
  const startedAt = Date.now();
  const totalTextLength = messages.reduce((sum, message) => {
    if (Array.isArray(message?.content)) {
      return sum + message.content.reduce((partSum, part) => partSum + (part?.type === "text" ? String(part.text || "").length : 0), 0);
    }
    return sum + String(message?.content || "").length;
  }, 0);
  console.info("[web2ai.ai.request] content stream start", JSON.stringify({
    label: debugLabel,
    modelId: STATE.activeModelId,
    messageCount: messages.length,
    totalTextLength
  }));
  let receivedContent = false;
  const handleChunk = (delta) => {
    if (delta) receivedContent = true;
    onChunk(delta);
  };
  const useCompatibilityMode = async () => {
    console.warn("[web2ai.ai.request] content compatibility fallback", JSON.stringify({
      label: debugLabel,
      modelId: STATE.activeModelId,
      elapsedMs: Date.now() - startedAt
    }));
    const response = await sendToBackground({
      type: "AI_CHAT",
      payload: { messages, modelId: STATE.activeModelId, debugLabel: `${debugLabel}-compat` }
    });
    if (!response?.ok) {
      throw new Error(`流式连接不可用，兼容模式请求也失败：${response?.error || "未知错误"}`);
    }
    const content = String(response.data?.content || "");
    if (!content.trim()) throw new Error("兼容模式请求成功，但模型没有返回内容");
    showToast("当前模型的流式连接不可用，已使用兼容模式完成请求", 4000);
    handleChunk(content);
    console.info("[web2ai.ai.request] content compatibility end", JSON.stringify({
      label: debugLabel,
      elapsedMs: Date.now() - startedAt,
      responseLength: content.length
    }));
  };
  try {
    await streamChatOnce({ messages, onChunk: handleChunk, debugLabel });
  } catch (error) {
    console.warn("[web2ai.ai.request] content stream error", JSON.stringify({
      label: debugLabel,
      phase: "initial",
      code: error?.code || "",
      elapsedMs: Date.now() - startedAt,
      receivedContent,
      error: String(error?.message ?? error)
    }));
    if (error?.code === "STREAM_TIMEOUT" && !receivedContent) {
      await useCompatibilityMode();
      return;
    }
    // 空闲端口或 Service Worker 恢复时可能恰好断开。尚未产生内容时安全地
    // 建立新 port 重试一次；收到部分结果后绝不重试，避免重复回答和计费。
    if (error?.code !== "STREAM_DISCONNECTED" || receivedContent) throw error;
    refs.chatPort = null;
    try {
      await streamChatOnce({ messages, onChunk: handleChunk, debugLabel: `${debugLabel}-retry` });
    } catch (retryError) {
      console.warn("[web2ai.ai.request] content stream error", JSON.stringify({
        label: debugLabel,
        phase: "retry",
        code: retryError?.code || "",
        elapsedMs: Date.now() - startedAt,
        receivedContent,
        error: String(retryError?.message ?? retryError)
      }));
      if (!["STREAM_DISCONNECTED", "STREAM_TIMEOUT"].includes(retryError?.code) || receivedContent) throw retryError;
      // 部分 OpenAI 兼容服务的普通请求可用，但 SSE 流会被网关或浏览器扩展
      // 通道提前关闭。两次流式连接均未收到内容时，使用同一模型做一次
      // 非流式兼容回退，确保千问、Kimi 等配置仍可完成分析。
      await useCompatibilityMode();
    }
  }
}

/**
 * 停止当前正在生成的 AI 回复（断开 port）。
 */
function stopGeneration() {
  for (const handler of [...refs.streamHandlers.values()]) {
    handler.onError({ code: "STREAM_STOPPED", message: "已停止生成" });
  }
  refs.streamHandlers.clear();
  if (refs.chatPort) {
    refs.chatPort.disconnect();
    refs.chatPort = null;
  }
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
