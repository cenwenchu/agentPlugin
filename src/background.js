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
import { MAX_SKILL_COLLECTION_PAGES, MAX_SKILL_COLLECTION_ROWS } from "./content/skill-collection-model.js";

// 生产默认不记录模型、页面和技能路由元数据。排障时可在本地临时开启，
// 但日志只能使用 summarizeAiMessages 等脱敏摘要，不得输出消息原文。
const DIAGNOSTIC_LOGS = false;

/** 跨浏览器标签页的数据源选择会话：sessionId → 发起方信息。 */
const SKILL_PICK_SESSIONS = new Map();
/** collectionId → { ownerTabId, sourceTabId }，用于跨标签页转发进度和停止。 */
const SKILL_COLLECTION_ROUTES = new Map();
/** 仅记录由扩展为采集自动创建的标签页；用户原有标签页永不自动关闭。 */
const SKILL_AUTO_OPENED_TABS = new Set();

chrome.tabs.onRemoved.addListener((tabId) => {
  SKILL_AUTO_OPENED_TABS.delete(tabId);
});

async function waitForTabReady(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("数据源页面已关闭");
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("数据源页面加载超时");
}

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

async function focusSkillSourceWhenReady(tabId, source) {
  if (!source) return false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
    const results = await Promise.all(frames.map(async (frame) => {
      try {
        return await sendToFrame(tabId, frame.frameId, { type: "FOCUS_SKILL_SOURCE", source });
      } catch {
        return null;
      }
    }));
    if (results.some((result) => result?.ok && result.data?.found)) return true;
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
  DIAGNOSTIC_LOGS && console.info("[web2ai.ai.request] non-stream start", JSON.stringify({
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
      messages
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI request failed: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  DIAGNOSTIC_LOGS && console.info("[web2ai.ai.request] non-stream end", JSON.stringify({
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

async function getTabPageKey(tabId) {
  const identity = await sendToFrame(tabId, 0, { type: "GET_PAGE_IDENTITY" }).catch(() => null);
  if (identity?.ok && identity.data?.url) return normalizedPageKey(identity.data.url);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return normalizedPageKey(tab?.url || "");
}

async function waitForTabPageKey(tabId, expectedPageKey, attempts = 12) {
  if (!expectedPageKey) return true;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await getTabPageKey(tabId) === expectedPageKey) return true;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
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
      const sessionId = message.payload?.sessionId;
      const storedPickKey = `web2aiSkillPick:${sessionId}`;
      const storedInitiator = (await chrome.storage.session.get([storedPickKey]))[storedPickKey];
      const initiator = SKILL_PICK_SESSIONS.get(sessionId) || storedInitiator || { tabId: sender.tab.id, kind: "content" };
      const initiatorTabId = initiator.tabId;
      SKILL_PICK_SESSIONS.delete(sessionId);
      await chrome.storage.session.remove(storedPickKey);
      const capturedSource = message.payload?.source || {};
      const selectedInTopFrame = capturedSource.isTopFrame === true;
      const selectedFrameId = selectedInTopFrame ? 0 : (sender.frameId || 0);
      // 表格所在 content script 在 pointerdown 时记录的 URL 最接近用户实际点击，
      // 优先级高于异步送达后台后的 sender.url。
      const selectedFrameUrl = normalizedPageKey(capturedSource.frameUrl || sender.url || "");
      // sender.tab.url 在站点内部 Tab/SPA 切换时可能仍是上一个路由。
      // 选中瞬间向 top frame 读取 location.href，作为数据源所属页面的权威值。
      const topIdentityResponse = await sendToFrame(sender.tab.id, 0, { type: "GET_PAGE_IDENTITY" }).catch(() => null);
      const topIdentity = topIdentityResponse?.ok ? topIdentityResponse.data : null;
      const selectedPageUrl = selectedInTopFrame
        ? (capturedSource.capturedPageUrl || capturedSource.frameUrl || sender.url || topIdentity?.url || sender.tab.url || "")
        : (topIdentity?.url || sender.tab.url || "");
      const payload = {
        ...message.payload,
        source: {
          ...message.payload?.source,
          // 顶层表格的标题由点击所在页面直接记录；iframe 表格才使用 top frame 标题。
          pageTitle: selectedInTopFrame
            ? (capturedSource.pageTitle || topIdentity?.title || "")
            : (topIdentity?.title || capturedSource.pageTitle || ""),
          businessTabTitle: topIdentity?.activeBusinessTabTitle || capturedSource.businessTabTitle || ""
        },
        frameId: selectedFrameId,
        frameUrl: selectedFrameUrl,
        pageKey: normalizedPageKey(selectedPageUrl),
        pageUrl: selectedPageUrl
      };
      DIAGNOSTIC_LOGS && console.info("[web2ai.skill-pick] accepted source", JSON.stringify({
        sessionId,
        frameId: selectedFrameId,
        frameUrl: selectedFrameUrl,
        senderTabUrl: normalizedPageKey(sender.tab.url || ""),
        topFrameUrl: normalizedPageKey(topIdentity?.url || ""),
        selectedPageKey: payload.pageKey,
        selector: payload.source?.selector || "",
        tableIndex: payload.source?.tableIndex ?? -1,
        headerCount: payload.source?.headers?.length || 0
      }));
      await sendToFrame(initiatorTabId, 0, { type: "SKILL_TABLE_PICK_RESULT", payload });
      const tabs = await chrome.tabs.query({});
      await Promise.allSettled(tabs.filter((tab) => tab.id).map((tab) => broadcastToTab(tab.id, { type: "CANCEL_SKILL_TABLE_PICK", sessionId })));
      sendResponse({ ok: true });
      // 先让目标页面的 pointerdown/click 调度完整结束，再切回技能编辑页。
      // 同步切换标签页可能中断网页自身事件，也会造成自动化 Runtime 调用悬挂。
      setTimeout(() => chrome.tabs.update(initiatorTabId, { active: true }).catch(() => void 0), 500);
      return;
    }
    if (message?.type === "START_SKILL_SOURCE_PICK") {
      if (!sender?.tab?.id) throw new Error("无法确定创建技能的标签页");
      const sessionId = String(message.sessionId || "");
      if (!sessionId) throw new Error("数据源选择会话无效");
      const initiator = {
        tabId: sender.tab.id,
        kind: "content"
      };
      SKILL_PICK_SESSIONS.set(sessionId, initiator);
      await chrome.storage.session.set({ [`web2aiSkillPick:${sessionId}`]: initiator });
      const tabs = await chrome.tabs.query({});
      const eligibleTabs = tabs.filter((tab) => tab.id && /^(https?|file):/i.test(tab.url || ""));
      await Promise.allSettled(eligibleTabs.map((tab) => broadcastToTab(tab.id, { type: "START_SKILL_TABLE_PICK", sessionId })));
      sendResponse({ ok: true, tabCount: eligibleTabs.length });
      return;
    }
    if (message?.type === "SKILL_COLLECTION_PROGRESS") {
      if (!sender?.tab?.id) throw new Error("无法确定采集数据所在标签页");
      const route = SKILL_COLLECTION_ROUTES.get(String(message.collectionId || ""));
      await sendToFrame(route?.ownerTabId || sender.tab.id, 0, message);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "STOP_SKILL_SOURCE_COLLECTION") {
      if (!sender?.tab?.id) throw new Error("无法确定采集数据所在标签页");
      const route = SKILL_COLLECTION_ROUTES.get(String(message.collectionId || ""));
      await broadcastToTab(route?.sourceTabId || sender.tab.id, message);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "CLOSE_AUTO_OPENED_SKILL_PAGE") {
      const requestedTabId = Number(message.tabId) || 0;
      const targetPageKey = normalizedPageKey(message.source?.pageKey || message.source?.pageUrl || "");
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((tab) => (
        tab.id && SKILL_AUTO_OPENED_TABS.has(tab.id) && (
          (requestedTabId && tab.id === requestedTabId) || (!requestedTabId && normalizedPageKey(tab.url || "") === targetPageKey)
        )
      )).map((tab) => tab.id);
      ids.forEach((tabId) => SKILL_AUTO_OPENED_TABS.delete(tabId));
      if (ids.length) await chrome.tabs.remove(ids).catch(() => void 0);
      sendResponse({ ok: true, closed: ids.length });
      return;
    }
    if (message?.type === "FINALIZE_SKILL_SOURCE_COLLECTION") {
      if (!sender?.tab?.id) throw new Error("无法确定技能执行页面");
      const sourceTabId = Number(message.sourceTabId) || 0;
      // 只有发起采集的测试/执行页面确认数据已经写入会话状态后，才恢复焦点
      // 和关闭扩展自动创建的页面。用户原本打开的页面只切回，不关闭。
      await chrome.tabs.update(sender.tab.id, { active: true }).catch(() => void 0);
      if (Number.isInteger(sender.tab.windowId)) await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => void 0);
      if (sourceTabId && sourceTabId !== sender.tab.id && SKILL_AUTO_OPENED_TABS.has(sourceTabId)) {
        SKILL_AUTO_OPENED_TABS.delete(sourceTabId);
        await chrome.tabs.remove(sourceTabId).catch(() => void 0);
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "EXECUTE_SKILL_FROM_PAGE") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const response = await sendToFrame(sender.tab.id, 0, { type: "EXECUTE_SKILL", skillId: message.skillId });
      sendResponse(response || { ok: true });
      return;
    }
    if (message?.type === "VALIDATE_SKILL_SOURCE") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const preferredFrameUrl = normalizedPageKey(message.source?.frameUrl || "");
      let best = null;
      let lastProbes = [];
      let lastFoundSignature = "";
      let stableFoundCount = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
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
        const preferredFramePresent = !preferredFrameUrl || lastProbes.some((probe) => probe.frameUrl === preferredFrameUrl);
        if (!preferredFramePresent && attempt >= 2) break;
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
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const targetFramePresent = Boolean(preferredFrameUrl && lastProbes.some((probe) => probe.frameUrl === preferredFrameUrl));
      sendResponse({
        ok: true,
        data: best || {
          status: "missing",
          found: false,
          targetFramePresent,
          probes: lastProbes
        }
      });
      return;
    }
    if (message?.type === "LOAD_SKILL_SOURCE_DATA") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const ownerTabId = sender.tab.id;
      const collectionId = String(message.collectionId || "");
      const preferredFrameUrl = normalizedPageKey(message.source?.frameUrl || "");
      const sourcePageKey = normalizedPageKey(message.source?.pageKey || message.source?.pageUrl || "");
      const tryCollectFromTab = async (tabId, attempts = 1) => {
        SKILL_COLLECTION_ROUTES.set(collectionId, { ownerTabId, sourceTabId: tabId });
        for (let attempt = 0; attempt < attempts; attempt++) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
          const ordered = [...frames].sort((a, b) => Number(normalizedPageKey(b.url) === preferredFrameUrl) - Number(normalizedPageKey(a.url) === preferredFrameUrl));
          for (const frame of ordered) {
            try {
              const validation = await sendToFrame(tabId, frame.frameId, {
                type: "CHECK_SKILL_SOURCE",
                source: message.source
              });
              if (!validation?.ok || !validation.data?.found) continue;
              if (validation.data.status === "changed") {
                return { changed: true, headers: validation.data.headers || [] };
              }
              const response = await sendToFrame(tabId, frame.frameId, {
                type: "COLLECT_SKILL_SOURCE_DATA",
                source: message.source,
                options: {
                  collectionId,
                  maxPages: Math.max(1, Math.min(MAX_SKILL_COLLECTION_PAGES, Number(message.maxPages) || 1)),
                  maxRows: Math.max(1, Math.min(MAX_SKILL_COLLECTION_ROWS, Number(message.maxRows) || MAX_SKILL_COLLECTION_ROWS)),
                  waitForInitialRowsMs: SKILL_AUTO_OPENED_TABS.has(tabId) ? 8000 : 2500
                }
              });
              if (response?.ok && response.data?.found) {
                return { best: { ...response.data, frameId: frame.frameId, frameUrl: normalizedPageKey(frame.url) } };
              }
            } catch { /* 页面或 frame 尚未完成注入，继续等待或尝试其他 frame */ }
          }
          if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return {};
      };

      let ownerMatchesSource = await waitForTabPageKey(ownerTabId, sourcePageKey, 1);
      if (!ownerMatchesSource && message.source?.businessTabTitle) {
        const activated = await sendToFrame(ownerTabId, 0, {
          type: "ACTIVATE_BUSINESS_PAGE_TAB",
          title: message.source.businessTabTitle
        }).catch(() => null);
        if (activated?.ok) ownerMatchesSource = await waitForTabPageKey(ownerTabId, sourcePageKey, 16);
      }
      let sourceTabId = ownerTabId;
      // 只有明确确认当前应用页面就是目标页面时才允许在 owner tab 采集。
      // 目标业务 Tab 已关闭时不能拿当前页的相似表格兜底。
      let result = ownerMatchesSource ? await tryCollectFromTab(ownerTabId, 2) : {};
      let openedOrSwitched = false;
      if (!result.best && !result.changed) {
        let sourceUrl = "";
        try {
          const parsed = new URL(message.source?.pageUrl || "");
          if (/^https?:$/.test(parsed.protocol)) sourceUrl = parsed.href;
        } catch { sourceUrl = ""; }
        if (!sourceUrl) {
          SKILL_COLLECTION_ROUTES.delete(collectionId);
          sendResponse({ ok: false, error: "数据源页面地址无效，无法自动打开" });
          return;
        }
        const tabs = await chrome.tabs.query({});
        let target = tabs.find((tab) => tab.id && tab.id !== ownerTabId && normalizedPageKey(tab.url || "") === sourcePageKey);
        if (!target?.id) {
          target = await chrome.tabs.create({ url: sourceUrl, active: true });
          SKILL_AUTO_OPENED_TABS.add(target.id);
        } else await chrome.tabs.update(target.id, { active: true });
        if (Number.isInteger(target.windowId)) await chrome.windows.update(target.windowId, { focused: true });
        sourceTabId = target.id;
        openedOrSwitched = true;
        await waitForTabReady(sourceTabId);
        // content script 和业务 iframe 往往晚于 document complete，限定时间内轮询定位。
        result = await tryCollectFromTab(sourceTabId, 24);
      }
      // 失败或需要用户确认结构变化时先回到执行页面展示提示；成功结果必须
      // 等执行页面写入数据并发送 FINALIZE 后才能切回或关闭来源页面。
      if (openedOrSwitched && !result.best) {
        await chrome.tabs.update(ownerTabId, { active: true }).catch(() => void 0);
        if (Number.isInteger(sender.tab.windowId)) await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => void 0);
      }
      const autoOpenedTabId = sourceTabId !== ownerTabId && SKILL_AUTO_OPENED_TABS.has(sourceTabId) ? sourceTabId : 0;
      SKILL_COLLECTION_ROUTES.delete(collectionId);
      if (result.changed) {
        sendResponse({ ok: false, code: "SOURCE_STRUCTURE_CHANGED", error: "数据源结构已更新", headers: result.headers, autoOpenedTabId });
      } else if (result.best) {
        sendResponse({
          ok: true,
          data: result.best,
          autoOpenedTabId,
          sourceTabId,
          requiresFinalize: openedOrSwitched
        });
      } else {
        if (autoOpenedTabId) {
          SKILL_AUTO_OPENED_TABS.delete(autoOpenedTabId);
          await chrome.tabs.remove(autoOpenedTabId).catch(() => void 0);
        }
        sendResponse({ ok: false, error: `已打开数据源页面，但在限定时间内未能读取“${message.source?.displayName || message.source?.pageTitle || "数据源"}”` });
      }
      return;
    }
    if (message?.type === "ACTIVATE_SKILL_BUSINESS_TAB") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const response = await sendToFrame(sender.tab.id, 0, {
        type: "ACTIVATE_BUSINESS_PAGE_TAB",
        title: message.title
      }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      sendResponse(response || { ok: false, error: "页面切换失败" });
      return;
    }
    if (message?.type === "INSPECT_SKILL_SOURCE_PAGINATION") {
      if (!sender?.tab?.id) throw new Error("无法确定技能所在标签页");
      const ownerTabId = sender.tab.id;
      const preferredFrameUrl = normalizedPageKey(message.source?.frameUrl || "");
      const sourcePageKey = normalizedPageKey(message.source?.pageKey || message.source?.pageUrl || "");
      const inspectTab = async (tabId, attempts = 1) => {
        let lastFound = null;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
          const ordered = [...frames].sort((a, b) => Number(normalizedPageKey(b.url) === preferredFrameUrl) - Number(normalizedPageKey(a.url) === preferredFrameUrl));
          for (const frame of ordered) {
            try {
              const response = await sendToFrame(tabId, frame.frameId, { type: "INSPECT_SKILL_SOURCE_PAGINATION", source: message.source });
              if (response?.ok && response.data?.found) {
                lastFound = response.data;
                // 应用内页面切换时表格通常先出现，分页控件稍后渲染。
                // 发现分页可以立即返回；暂时未发现时继续观察到限定窗口结束。
                if (response.data.multiPage) return response.data;
              }
            } catch { void 0; }
          }
          if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return lastFound;
      };
      let ownerMatchesSource = await waitForTabPageKey(ownerTabId, sourcePageKey, 1);
      if (!ownerMatchesSource && message.source?.businessTabTitle) {
        const activated = await sendToFrame(ownerTabId, 0, {
          type: "ACTIVATE_BUSINESS_PAGE_TAB",
          title: message.source.businessTabTitle
        }).catch(() => null);
        if (activated?.ok) ownerMatchesSource = await waitForTabPageKey(ownerTabId, sourcePageKey, 16);
      }
      // 当前页面只需短暂确认；刚切换的应用内页面最多等待约6秒，让分页
      // 与异步表格完成渲染。没有分页时最终仍返回单页，不会误报多页。
      let data = ownerMatchesSource ? await inspectTab(ownerTabId, 3) : null;
      if (!data) {
        let sourceUrl = "";
        try {
          const parsed = new URL(message.source?.pageUrl || "");
          if (/^https?:$/.test(parsed.protocol)) sourceUrl = parsed.href;
        } catch { sourceUrl = ""; }
        if (sourceUrl) {
          const tabs = await chrome.tabs.query({});
          let target = tabs.find((tab) => tab.id && tab.id !== ownerTabId && normalizedPageKey(tab.url || "") === sourcePageKey);
          if (!target?.id) {
            target = await chrome.tabs.create({ url: sourceUrl, active: true });
            SKILL_AUTO_OPENED_TABS.add(target.id);
          } else await chrome.tabs.update(target.id, { active: true });
          await waitForTabReady(target.id).catch(() => null);
          data = await inspectTab(target.id, 24);
          await chrome.tabs.update(ownerTabId, { active: true }).catch(() => void 0);
          if (Number.isInteger(sender.tab.windowId)) await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => void 0);
        }
      }
      sendResponse({ ok: true, data: data || { found: false, multiPage: false, totalPages: 0 } });
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
          await focusSkillSourceWhenReady(sender.tab.id, message.source);
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
      await focusSkillSourceWhenReady(target.id, message.source);
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

    if (message?.type === "REFRESH_SKILLS_ALL_TABS") {
      const tabs = await chrome.tabs.query({});
      const results = await Promise.allSettled(tabs.filter((tab) => tab.id && /^(https?|file):/i.test(tab.url || "")).map((tab) => (
        sendToFrame(tab.id, 0, { type: "RELOAD_SKILLS" })
      )));
      sendResponse({ ok: true, refreshed: results.filter((result) => result.status === "fulfilled" && result.value?.ok).length });
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
      DIAGNOSTIC_LOGS && console.info("[web2ai.ai.request] stream start", JSON.stringify({
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
        DIAGNOSTIC_LOGS && console.info("[web2ai.ai.request] stream end", JSON.stringify({
          requestId,
          label: debugLabel,
          elapsedMs: Date.now() - startedAt,
          firstChunkMs: firstChunkAt ? firstChunkAt - startedAt : null
        }));
        port.postMessage({ type: "AI_CHAT_STREAM_END", requestId });
      } catch (e) {
        DIAGNOSTIC_LOGS && console.warn("[web2ai.ai.request] stream error", JSON.stringify({
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
