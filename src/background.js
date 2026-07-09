const DEFAULT_SETTINGS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  apiKey: ""
};

async function getSettings() {
  const data = await chrome.storage.sync.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
}

async function ensureDefaultSettings() {
  const data = await chrome.storage.sync.get(["settings"]);
  if (!data.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
}

function buildChatCompletionsUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

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
      temperature: 0.2
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
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      const delta =
        json?.choices?.[0]?.delta?.content ??
        json?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.text ??
        "";
      if (delta) onDelta(delta);
    }
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function broadcastToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function contextsKey(tabId) {
  return `web2ai_contexts_${tabId}`;
}

async function getTabContexts(tabId) {
  const key = contextsKey(tabId);
  const data = await chrome.storage.session.get([key]);
  const contexts = data?.[key];
  return Array.isArray(contexts) ? contexts : [];
}

async function setTabContexts(tabId, contexts) {
  const key = contextsKey(tabId);
  await chrome.storage.session.set({ [key]: contexts });
}

async function clearTabContexts(tabId) {
  const key = contextsKey(tabId);
  await chrome.storage.session.remove([key]);
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultSettings();

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "web2ai_add_selection",
    title: "添加选中内容到 AI 上下文",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "web2ai_add_page",
    title: "添加整页内容到 AI 上下文",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "web2ai_open_panel",
    title: "打开 AI Chat 浮层",
    contexts: ["page", "selection"]
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

    if (info.menuItemId === "web2ai_add_selection") {
      await sendToFrame(tab.id, frameId, {
        type: "ADD_CONTEXT_SNIPPET",
        snippet: {
          kind: "selection",
          text: info.selectionText ?? "",
          url: tab.url ?? "",
          title: tab.title ?? ""
        }
      });
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
      await sendToTab(tab.id, { type: "TOAST", message: String(e?.message ?? e) });
    } catch {
      void 0;
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "AI_CHAT") {
      const data = await chatCompletions(message.payload);
      sendResponse({ ok: true, data });
      return;
    }
    if (message?.type === "GET_SETTINGS") {
      const settings = await getSettings();
      sendResponse({ ok: true, data: settings });
      return;
    }
    if (message?.type === "OPEN_OPTIONS") {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    const tabId = sender?.tab?.id;
    if (message?.type === "STORE_CONTEXT") {
      if (!tabId) throw new Error("Missing tabId");
      const context = message.payload?.context;
      if (!context?.ref) throw new Error("Missing context.ref");
      const list = await getTabContexts(tabId);
      const next = [context, ...list.filter((c) => c?.ref !== context.ref)].slice(0, 50);
      await setTabContexts(tabId, next);
      sendResponse({ ok: true, data: { count: next.length } });
      return;
    }

    if (message?.type === "REMOVE_CONTEXT") {
      if (!tabId) throw new Error("Missing tabId");
      const ref = message.payload?.ref;
      const list = await getTabContexts(tabId);
      const next = list.filter((c) => c?.ref !== ref);
      await setTabContexts(tabId, next);
      sendResponse({ ok: true, data: { count: next.length } });
      return;
    }

    if (message?.type === "CLEAR_CONTEXTS") {
      if (!tabId) throw new Error("Missing tabId");
      await clearTabContexts(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "LIST_CONTEXTS") {
      if (!tabId) throw new Error("Missing tabId");
      const list = await getTabContexts(tabId);
      sendResponse({ ok: true, data: { contexts: list } });
      return;
    }

    if (message?.type === "FORWARD_TO_TOP") {
      if (!tabId) throw new Error("Missing tabId");
      const msg = message.payload?.message;
      if (!msg) throw new Error("Missing payload.message");
      await sendToFrame(tabId, 0, msg);
      sendResponse({ ok: true });
      return;
    }

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

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabContexts(tabId).catch(() => void 0);
});

const ACTIVE_STREAMS = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "web2ai_chat") return;
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
