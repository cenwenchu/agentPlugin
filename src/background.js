/**
 * @fileoverview Background Service Worker (Manifest V3)。
 *
 * 核心职责：
 * 1. 右键“打开 Chat/截图”菜单、工具栏入口与当前标签页截图
 * 2. AI API 请求代理（非流式 + 流式 SSE）
 * 3. 长连接管理（流式 AI 对话的 Port 通信）
 * 4. 设置分层：普通配置存 sync，API Key 存 local
 */

import { DEFAULT_MODEL_PROFILE, DEFAULT_SETTINGS } from "./shared.js";
import { createSseDataParser } from "./sse.js";

function summarizeAiMessages(messages = []) {
  const summary = messages.map((message) => {
    const parts = Array.isArray(message?.content) ? message.content : null;
    const textLength = parts
      ? parts.reduce((sum, part) => sum + (part?.type === "text" ? String(part.text || "").length : 0), 0)
      : String(message?.content || "").length;
    return {
      role: message?.role || "unknown",
      textLength,
      imageCount: parts ? parts.filter((part) => part?.type === "image_url").length : 0
    };
  });
  return {
    messageCount: summary.length,
    totalTextLength: summary.reduce((sum, item) => sum + item.textLength, 0),
    totalImages: summary.reduce((sum, item) => sum + item.imageCount, 0),
    messages: summary
  };
}

function sanitizeAiMessages(messages = []) {
  return messages.filter((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role)) return false;
    if (Array.isArray(message.content)) {
      return message.content.some((part) => (
        part?.type === "image_url" || (part?.type === "text" && String(part.text || "").trim())
      ));
    }
    return Boolean(String(message.content || "").trim());
  });
}

function normalizedPageKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "");
  }
}

async function openSkillsPanelWhenReady(tabId) {
  // 导航完成不代表 content script 已完成动态 import；短时重试可覆盖两者时序。
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        const response = await sendToFrame(tabId, 0, { type: "OPEN_SKILLS_PANEL" });
        if (response?.ok) return true;
      }
    } catch { void 0; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// ========== 设置 ==========

/**
 * 获取用户设置（合并默认值）。
 * @returns {Promise<Object>} 当前模型的扁平配置，同时包含全部脱敏模型元数据
 */
async function getSettings(preferredModelId = "") {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(["settings"]),
    chrome.storage.local.get(["apiKey", "modelApiKeys"])
  ]);
  const synced = syncData.settings ?? {};
  let models = Array.isArray(synced.models) && synced.models.length ? synced.models : null;
  let activeModelId = synced.activeModelId || synced.defaultModelId;
  let modelApiKeys = { ...(localData.modelApiKeys ?? {}) };

  // 将旧版单模型配置无损迁移为模型列表；密钥继续只保存在 local。
  if (!models) {
    const legacy = { ...DEFAULT_MODEL_PROFILE, ...synced, id: "default", name: synced.model || DEFAULT_MODEL_PROFILE.name };
    delete legacy.apiKey;
    models = [legacy];
    activeModelId = legacy.id;
    const legacyKey = localData.apiKey || synced.apiKey || "";
    if (legacyKey) modelApiKeys[legacy.id] = legacyKey;
    await Promise.all([
      chrome.storage.sync.set({ settings: { models, activeModelId } }),
      chrome.storage.local.set({ modelApiKeys })
    ]);
  }
  const active = models.find((profile) => profile.id === preferredModelId) || models.find((profile) => profile.id === activeModelId) || models[0];
  activeModelId = active.id;
  return {
    ...DEFAULT_MODEL_PROFILE,
    ...active,
    activeModelId,
    defaultModelId: synced.defaultModelId || activeModelId,
    models: models.map((profile) => ({ ...profile, hasApiKey: Boolean(modelApiKeys[profile.id]) })),
    apiKey: modelApiKeys[active.id] || ""
  };
}

/**
 * 确保首次安装时有默认设置。
 */
async function ensureDefaultSettings() {
  const data = await chrome.storage.sync.get(["settings"]);
  if (!data.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  } else if (!Array.isArray(data.settings.models) || data.settings.apiKey) {
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
async function chatCompletions({ messages, modelId = "", debugLabel = "chat" }) {
  messages = sanitizeAiMessages(messages);
  const settings = await getSettings(modelId);
  const startedAt = Date.now();
  console.info("[web2ai.ai.request] non-stream start", JSON.stringify({
    label: debugLabel,
    modelId: settings.id,
    model: settings.model,
    ...summarizeAiMessages(messages)
  }));
  if (!settings.apiKey) {
    throw new Error("Missing API Key. Please set it in the extension Options.");
  }
  if (!settings.supportsImages && messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url"))) {
    throw new Error(`当前模型“${settings.name || settings.model}”未配置为支持图片`);
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
  console.info("[web2ai.ai.request] non-stream end", JSON.stringify({
    label: debugLabel,
    modelId: settings.id,
    elapsedMs: Date.now() - startedAt,
    responseLength: content.length
  }));
  return { raw: json, content };
}

/**
 * 发送流式 AI 对话请求（SSE）。
 * 逐行解析 data: 开头的 JSON 片段，提取 delta 内容。
 * @param {{messages: Array, signal: AbortSignal, onDelta: Function, onActivity?: Function}} params
 */
async function streamChatCompletions({ messages, modelId = "", signal, onDelta, onActivity = () => void 0 }) {
  messages = sanitizeAiMessages(messages);
  const settings = await getSettings(modelId);
  if (!settings.apiKey) {
    throw new Error("Missing API Key. Please set it in the extension Options.");
  }
  if (!settings.supportsImages && messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url"))) {
    throw new Error(`当前模型“${settings.name || settings.model}”未配置为支持图片`);
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
    onActivity();
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

async function broadcastToTab(tabId, message) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return Promise.allSettled(frames.map((frame) => sendToFrame(tabId, frame.frameId, message)));
}

// ========== 安装 & 右键菜单 ==========

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultSettings();

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "web2ai_open_panel",
    title: "打开 AI Chat 浮层",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "web2ai_capture_region",
    title: "截图（框选区域）",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "web2ai_capture_multiple",
    title: "多屏截图（最多 5 屏）",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "web2ai_create_skill",
    title: "创建技能",
    contexts: ["all"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === "web2ai_open_panel") {
      await sendToFrame(tab.id, 0, { type: "OPEN_PANEL" });
      return;
    }
    if (info.menuItemId === "web2ai_capture_region") {
      // 无论右键发生在哪个 iframe，都由顶层 frame 展示 Chat 和区域选择器。
      await sendToFrame(tab.id, 0, { type: "START_REGION_SCREENSHOT" });
      return;
    }
    if (info.menuItemId === "web2ai_capture_multiple") {
      await sendToFrame(tab.id, 0, { type: "START_MULTI_SCREEN_SCREENSHOT" });
      return;
    }
    if (info.menuItemId === "web2ai_create_skill") {
      await sendToFrame(tab.id, 0, { type: "START_SKILL_CREATION" });
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
      const settings = await getSettings(message.modelId || "");
      const { apiKey, ...safeSettings } = settings;
      sendResponse({ ok: true, data: { ...safeSettings, hasApiKey: Boolean(apiKey) } });
      return;
    }
    if (message?.type === "SET_ACTIVE_MODEL") {
      const modelId = String(message.modelId || "");
      const data = await chrome.storage.sync.get(["settings"]);
      const settings = data.settings ?? DEFAULT_SETTINGS;
      const models = Array.isArray(settings.models) ? settings.models : [];
      if (!models.some((profile) => profile.id === modelId)) throw new Error("模型配置不存在");
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SKILL_TABLE_PICK_RESULT") {
      if (!sender?.tab?.id) throw new Error("无法确定选择数据源的标签页");
      await sendToFrame(sender.tab.id, 0, {
        type: "SKILL_TABLE_PICK_RESULT",
        payload: { ...message.payload, frameId: sender.frameId || 0, frameUrl: normalizedPageKey(sender.url || "") }
      });
      await broadcastToTab(sender.tab.id, { type: "CANCEL_SKILL_TABLE_PICK", sessionId: message.payload?.sessionId });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "VALIDATE_SKILL_SOURCE") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const preferredFrameUrl = normalizedPageKey(message.source?.frameUrl || "");
      let best = null;
      let lastProbes = [];
      let lastFoundSignature = "";
      let stableFoundCount = 0;
      // 页面刷新后，top frame 的技能配置通常早于业务子 frame 和异步表格完成渲染。
      // 在有限窗口内重新枚举 frame 并校验，避免把“尚未渲染”误报成永久失效。
      for (let attempt = 0; attempt < 40; attempt++) {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
        const ordered = [...frames].sort((a, b) => Number(normalizedPageKey(b.url) === preferredFrameUrl) - Number(normalizedPageKey(a.url) === preferredFrameUrl));
        const frameResults = await Promise.all(ordered.map(async (frame) => {
          try {
            const response = await sendToFrame(sender.tab.id, frame.frameId, { type: "CHECK_SKILL_SOURCE", source: message.source });
            return response?.ok
              ? { ...(response.data || {}), frameId: frame.frameId, frameUrl: normalizedPageKey(frame.url) }
              : { found: false, frameId: frame.frameId, frameUrl: normalizedPageKey(frame.url), error: response?.error || "check failed" };
          } catch (error) { return { found: false, frameId: frame.frameId, frameUrl: normalizedPageKey(frame.url), error: String(error?.message ?? error) }; }
        }));
        lastProbes = frameResults.map((result) => ({
          frameId: result.frameId,
          frameUrl: result.frameUrl,
          found: Boolean(result.found),
          candidateCount: result.candidateCount || 0,
          error: result.error || ""
        }));
        const results = frameResults.filter((result) => result.found);
        const candidate = results.sort((a, b) => {
          const similarityDiff = (b.similarity || 0) - (a.similarity || 0);
          if (similarityDiff) return similarityDiff;
          return Number(normalizedPageKey(b.frameUrl) === preferredFrameUrl) - Number(normalizedPageKey(a.frameUrl) === preferredFrameUrl);
        })[0];
        if (candidate && (!best || (candidate.similarity || 0) > (best.similarity || 0))) best = candidate;
        if (best?.status === "available") break;
        if (candidate?.found) {
          const signature = JSON.stringify(candidate.headers || []);
          stableFoundCount = signature === lastFoundSignature ? stableFoundCount + 1 : 1;
          lastFoundSignature = signature;
          // 异步表格可能先出现部分列；连续三次相同后才接受“已变化”，
          // 避免等待满 30 秒并重复打印同一诊断。
          if (stableFoundCount >= 3) break;
        } else {
          stableFoundCount = 0;
          lastFoundSignature = "";
        }
        if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 750));
      }
      sendResponse({ ok: true, data: best || { status: "missing", found: false, probes: lastProbes } });
      return;
    }
    if (message?.type === "LOAD_SKILL_SOURCE_DATA") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const preferredFrameUrl = normalizedPageKey(message.source?.frameUrl || "");
      const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
      const ordered = [...frames].sort((a, b) => Number(normalizedPageKey(b.url) === preferredFrameUrl) - Number(normalizedPageKey(a.url) === preferredFrameUrl));
      const results = [];
      for (const frame of ordered) {
        try {
          const response = await sendToFrame(sender.tab.id, frame.frameId, {
            type: "EXTRACT_SKILL_SOURCE_DATA",
            source: message.source,
            limit: 200
          });
          if (response?.ok && response.data?.found) {
            results.push({ ...response.data, frameId: frame.frameId, frameUrl: normalizedPageKey(frame.url) });
          }
        } catch { /* frame 尚未注入时继续尝试其他 frame */ }
      }
      const best = results.sort((a, b) => {
        const preferred = Number(b.frameUrl === preferredFrameUrl) - Number(a.frameUrl === preferredFrameUrl);
        return preferred || (b.rowCount || 0) - (a.rowCount || 0);
      })[0];
      sendResponse(best
        ? { ok: true, data: best }
        : { ok: false, error: "未能读取数据源，请确认数据源所在页面已打开且内容已加载" });
      return;
    }
    if (message?.type === "SWITCH_TO_SKILL_PAGE") {
      const targetPageKey = String(message.pageKey || normalizedPageKey(message.pageUrl));
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((tab) => tab.id && tab.url && normalizedPageKey(tab.url) === targetPageKey);
      if (!target?.id) {
        if (message.allowNavigateCurrentTab && sender?.tab?.id && message.pageUrl) {
          let targetUrl;
          try {
            targetUrl = new URL(message.pageUrl);
            if (!/^https?:$/.test(targetUrl.protocol) || normalizedPageKey(targetUrl.href) !== targetPageKey) throw new Error("Invalid skill page URL");
          } catch {
            sendResponse({ ok: false, error: "技能页面地址无效" });
            return;
          }
          await chrome.tabs.update(sender.tab.id, { active: true, url: targetUrl.href });
          if (Number.isInteger(sender.tab.windowId)) await chrome.windows.update(sender.tab.windowId, { focused: true });
          await openSkillsPanelWhenReady(sender.tab.id);
          sendResponse({ ok: true, data: { tabId: sender.tab.id, navigated: true } });
          return;
        }
        sendResponse({ ok: false, code: "PAGE_NOT_OPEN", error: "目标页面尚未打开" });
        return;
      }
      if (Number.isInteger(target.windowId)) await chrome.windows.update(target.windowId, { focused: true });
      await chrome.tabs.update(target.id, { active: true });
      const opened = await openSkillsPanelWhenReady(target.id);
      if (!opened) {
        sendResponse({ ok: false, error: "已切换页面，但暂时无法打开技能面板，请刷新页面后重试" });
        return;
      }
      sendResponse({ ok: true, data: { tabId: target.id } });
      return;
    }
    // 捕获发起请求的标签页当前可见区域。图片只返回给内容脚本并保存在页面内存。
    if (message?.type === "CAPTURE_VISIBLE_TAB") {
      const windowId = sender?.tab?.windowId;
      if (!Number.isInteger(windowId)) throw new Error("无法确定当前窗口");
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 82 });
      sendResponse({ ok: true, data: { dataUrl, capturedAt: Date.now() } });
      return;
    }
    // 打开设置页
    if (message?.type === "OPEN_OPTIONS") {
      if (chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    const tabId = sender?.tab?.id;
    if (message?.type === "FIND_MULTI_SCREEN_SCROLL_TARGET") {
      if (!tabId) throw new Error("Missing tabId");
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const results = await Promise.all(frames.map(async (frame) => {
        try {
          const response = await sendToFrame(tabId, frame.frameId, { type: "GET_MULTI_SCREEN_SCROLL_INFO" });
          return response?.ok ? { frameId: frame.frameId, ...response.data } : null;
        } catch { return null; }
      }));
      const available = results.filter(Boolean);
      const selected = available.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      sendResponse({ ok: true, data: selected || { frameId: 0, kind: "window", label: "window", x: 0, y: 0, maxY: 0, viewportHeight: sender.tab?.height || 0 } });
      return;
    }
    if (message?.type === "SET_MULTI_SCREEN_SCROLL_POSITION" || message?.type === "RESTORE_MULTI_SCREEN_SCROLL_POSITION") {
      if (!tabId || !Number.isInteger(message.frameId)) throw new Error("Missing target frame");
      const forwardedType = message.type === "SET_MULTI_SCREEN_SCROLL_POSITION"
        ? "SET_MULTI_SCREEN_SCROLL_POSITION"
        : "RESTORE_MULTI_SCREEN_SCROLL_POSITION";
      const response = await sendToFrame(tabId, message.frameId, { ...message, type: forwardedType });
      sendResponse(response || { ok: true });
      return;
    }
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
    if (message?.type === "AI_CHAT_STREAM_HEARTBEAT") {
      // 双向消息活动可阻止首 token 前的 MV3 Service Worker 30 秒空闲回收。
      try { port.postMessage({ type: "AI_CHAT_STREAM_HEARTBEAT_ACK", requestId: message.requestId }); } catch { void 0; }
      return;
    }
    (async () => {
      if (message?.type !== "AI_CHAT_STREAM") return;
      const requestId = message.requestId;
      if (!requestId) return;

      const abort = new AbortController();
      ACTIVE_STREAMS.set(requestId, abort);
      portStreams.add(requestId);
      let timedOut = false;
      let watchdog = null;
      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, 90000);
      };
      resetWatchdog();
      const debugLabel = String(message.payload?.debugLabel || "chat");
      const startedAt = Date.now();
      let firstChunkAt = 0;
      console.info("[web2ai.ai.request] stream start", JSON.stringify({
        requestId,
        label: debugLabel,
        modelId: message.payload?.modelId || "",
        ...summarizeAiMessages(message.payload?.messages || [])
      }));

      try {
        await streamChatCompletions({
          messages: message.payload?.messages ?? [],
          modelId: message.payload?.modelId || "",
          signal: abort.signal,
          onActivity: resetWatchdog,
          onDelta: (delta) => {
            if (!firstChunkAt) firstChunkAt = Date.now();
            port.postMessage({ type: "AI_CHAT_STREAM_CHUNK", requestId, delta });
          }
        });
        console.info("[web2ai.ai.request] stream end", JSON.stringify({
          requestId,
          label: debugLabel,
          elapsedMs: Date.now() - startedAt,
          firstChunkMs: firstChunkAt ? firstChunkAt - startedAt : null
        }));
        port.postMessage({ type: "AI_CHAT_STREAM_END", requestId });
      } catch (e) {
        console.warn("[web2ai.ai.request] stream error", JSON.stringify({
          requestId,
          label: debugLabel,
          elapsedMs: Date.now() - startedAt,
          firstChunkMs: firstChunkAt ? firstChunkAt - startedAt : null,
          timedOut,
          error: String(e?.message ?? e)
        }));
        port.postMessage({
          type: "AI_CHAT_STREAM_ERROR",
          requestId,
          code: timedOut ? "STREAM_TIMEOUT" : "AI_STREAM_ERROR",
          error: timedOut
            ? "模型超过 90 秒没有返回任何新数据，请重试或切换模型"
            : String(e?.message ?? e)
        });
      } finally {
        if (watchdog) clearTimeout(watchdog);
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
