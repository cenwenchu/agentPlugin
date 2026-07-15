/**
 * @fileoverview Background Service Worker (Manifest V3)。
 *
 * 核心职责：
 * 1. 右键菜单管理（添加整页内容到 AI 上下文、打开浮层）与工具栏入口
 * 2. AI API 请求代理（非流式 + 流式 SSE）
 * 3. 长连接管理（流式 AI 对话的 Port 通信）
 * 4. 设置分层：普通配置存 sync，API Key 存 local
 */

import { DEFAULT_SETTINGS } from "./shared.js";
import { createSseDataParser } from "./sse.js";

// ========== 设置 ==========

/**
 * 获取用户设置（合并默认值）。
 * @returns {Promise<{baseUrl:string, model:string, contextWindow:number, maxOutputTokens:number, apiKey:string}>}
 */
async function getSettings() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(["settings"]),
    chrome.storage.local.get(["apiKey"])
  ]);
  const synced = syncData.settings ?? {};
  // 旧版本曾把密钥放入 sync；首次读取时迁移到 local 并清除同步副本。
  if (!localData.apiKey && synced.apiKey) {
    await chrome.storage.local.set({ apiKey: synced.apiKey });
    const { apiKey: _removed, ...safeSettings } = synced;
    await chrome.storage.sync.set({ settings: safeSettings });
    return { ...DEFAULT_SETTINGS, ...safeSettings, apiKey: synced.apiKey };
  }
  return { ...DEFAULT_SETTINGS, ...synced, apiKey: localData.apiKey ?? "" };
}

/**
 * 确保首次安装时有默认设置。
 */
async function ensureDefaultSettings() {
  const data = await chrome.storage.sync.get(["settings"]);
  if (!data.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  } else if (data.settings.apiKey) {
    await getSettings();
  }
}

// ========== AI API 请求 ==========

/**
 * 构建 Chat Completions API URL。
 * 自动补充 /v1/chat/completions 后缀。
 * @param {string} baseUrl
 * @returns {string}
 */
function buildChatCompletionsUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

/**
 * 发送非流式 AI 对话请求。
 * @param {{messages: Array}} params
 * @returns {Promise<{raw: Object, content: string}>}
 */
async function chatCompletions({ messages }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("Missing API Key. Please set it in the extension Options.");
  }

  const url = buildChatCompletionsUrl(settings.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.2,
      max_tokens: settings.maxOutputTokens
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI request failed: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  return { raw: json, content };
}

/**
 * 发送流式 AI 对话请求（SSE）。
 * 逐行解析 data: 开头的 JSON 片段，提取 delta 内容。
 * @param {{messages: Array, signal: AbortSignal, onDelta: Function}} params
 */
async function streamChatCompletions({ messages, signal, onDelta }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("Missing API Key. Please set it in the extension Options.");
  }

  const url = buildChatCompletionsUrl(settings.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.2,
      max_tokens: settings.maxOutputTokens,
      stream: true
    }),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI request failed: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  }
  if (!res.body) throw new Error("Missing response body stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let doneReceived = false;
  const parser = createSseDataParser((data) => {
    if (data === "[DONE]") {
      doneReceived = true;
      return;
    }
    try {
      const json = JSON.parse(data);
      const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
      if (delta) onDelta(delta);
    } catch {
      void 0;
    }
  });

  while (!doneReceived) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  parser.feed(decoder.decode());
  parser.end();
}

// ========== Tab 消息通信 ==========

/**
 * 向指定 tab 发送消息。
 * @param {number} tabId
 * @param {Object} message
 * @returns {Promise}
 */
function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(response);
    });
  });
}

/**
 * 向指定 frame 发送消息。
 * @param {number} tabId
 * @param {number} frameId
 * @param {Object} message
 * @returns {Promise}
 */
function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(response);
    });
  });
}

/** @deprecated sendToTab 的别名，兼容旧调用 */
const broadcastToTab = sendToTab;

// ========== 安装 & 右键菜单 ==========

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultSettings();

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "web2ai_add_page",
    title: "添加整页内容到 AI 上下文",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "web2ai_open_panel",
    title: "打开 AI Chat 浮层",
    contexts: ["page"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const frameId = typeof info?.frameId === "number" ? info.frameId : 0;

  try {
    if (info.menuItemId === "web2ai_open_panel") {
      await sendToFrame(tab.id, 0, { type: "OPEN_PANEL" });
      return;
    }

    if (info.menuItemId === "web2ai_add_page") {
      const captured = await sendToFrame(tab.id, frameId, { type: "CAPTURE_PAGE" });
      const snippet = captured?.snippet;
      if (snippet?.text) {
        await sendToFrame(tab.id, frameId, { type: "ADD_CONTEXT_SNIPPET", snippet });
        await sendToFrame(tab.id, 0, { type: "OPEN_PANEL" });
      }
      return;
    }
  } catch (e) {
    try {
      await sendToTab(tab.id, { type: "TOAST", text: String(e?.message ?? e) });
    } catch {
      void 0;
    }
  }
});

// 点击浏览器工具栏中的扩展图标，重新显示当前页面的 Chat 启动图标。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await sendToFrame(tab.id, 0, { type: "SHOW_LAUNCHER" });
  } catch {
    // chrome:// 等不允许内容脚本运行的页面无需提示。
    void 0;
  }
});

// ========== 消息路由 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    // 非流式 AI 请求
    if (message?.type === "AI_CHAT") {
      const data = await chatCompletions(message.payload);
      sendResponse({ ok: true, data });
      return;
    }
    // 获取设置
    if (message?.type === "GET_SETTINGS") {
      const settings = await getSettings();
      const { apiKey, ...safeSettings } = settings;
      sendResponse({ ok: true, data: { ...safeSettings, hasApiKey: Boolean(apiKey) } });
      return;
    }
    // 打开设置页
    if (message?.type === "OPEN_OPTIONS") {
      if (chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    const tabId = sender?.tab?.id;
    // 转发消息到 top frame
    if (message?.type === "FORWARD_TO_TOP") {
      if (!tabId) throw new Error("Missing tabId");
      const msg = message.payload?.message;
      if (!msg) throw new Error("Missing payload.message");
      await sendToFrame(tabId, 0, msg);
      sendResponse({ ok: true });
      return;
    }

    // 广播消息到 tab（所有 frame）
    if (message?.type === "BROADCAST_TO_TAB") {
      if (!tabId) throw new Error("Missing tabId");
      const msg = message.payload?.message;
      if (!msg) throw new Error("Missing payload.message");
      await broadcastToTab(tabId, msg);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));

  return true; // 保持 sendResponse 通道打开（异步响应）
});

// ========== 流式对话长连接管理 ==========

/** 活跃的流式请求 Map<requestId, AbortController> */
const ACTIVE_STREAMS = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "web2ai_chat") return;
  /** 该 port 上发起的流请求 ID 集合 */
  const portStreams = new Set();

  port.onMessage.addListener((message) => {
    (async () => {
      if (message?.type !== "AI_CHAT_STREAM") return;
      const requestId = message.requestId;
      if (!requestId) return;

      const abort = new AbortController();
      ACTIVE_STREAMS.set(requestId, abort);
      portStreams.add(requestId);

      try {
        await streamChatCompletions({
          messages: message.payload?.messages ?? [],
          signal: abort.signal,
          onDelta: (delta) => port.postMessage({ type: "AI_CHAT_STREAM_CHUNK", requestId, delta })
        });
        port.postMessage({ type: "AI_CHAT_STREAM_END", requestId });
      } catch (e) {
        port.postMessage({
          type: "AI_CHAT_STREAM_ERROR",
          requestId,
          error: String(e?.message ?? e)
        });
      } finally {
        ACTIVE_STREAMS.delete(requestId);
        portStreams.delete(requestId);
      }
    })().catch(() => void 0);
  });

  port.onDisconnect.addListener(() => {
    for (const requestId of portStreams) {
      const abort = ACTIVE_STREAMS.get(requestId);
      if (abort) abort.abort();
      ACTIVE_STREAMS.delete(requestId);
    }
    portStreams.clear();
  });
});
