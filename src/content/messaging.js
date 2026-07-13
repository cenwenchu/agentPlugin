import { uid, STATE, refs } from './state.js';
import { showToast } from './toast.js';

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

async function storeContextToBackground(context) {
  try {
    await chrome.runtime.sendMessage({ type: "STORE_CONTEXT", payload: { context } });
  } catch {
    void 0;
  }
}

async function removeContextInBackground(ref) {
  try {
    await chrome.runtime.sendMessage({ type: "REMOVE_CONTEXT", payload: { ref } });
  } catch {
    void 0;
  }
}

async function clearContextsInBackground() {
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_CONTEXTS" });
  } catch {
    void 0;
  }
}

function parseMaxCtxNum(contexts) {
  return contexts
    .map((c) => String(c?.ref || ""))
    .map((r) => {
      const m = r.match(/^CTX(\d+)$/);
      return m ? Number(m[1]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
}

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
    STATE.tableGroups = [];
    for (const c of contexts) {
      if (c.kind === "table-header") {
        STATE.tableGroups.push({ id: `TG${Date.now()}_${Math.random().toString(36).slice(2,6)}`, header: c, rows: [] });
      } else if (c.kind === "table-row") {
        const lastGroup = STATE.tableGroups[STATE.tableGroups.length - 1];
        if (lastGroup) {
          lastGroup.rows.push(c);
        } else {
          STATE.tableGroups.push({ id: `TG${Date.now()}_${Math.random().toString(36).slice(2,6)}`, header: null, rows: [c] });
        }
      }
    }
    // Dynamic import to avoid circular dependency (overlay.js -> messaging.js)
    const { render } = await import('./overlay.js');
    render();
  } catch {
    void 0;
  }
}

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

function stopGeneration() {
  if (refs.chatPort) {
    refs.chatPort.disconnect();
    refs.chatPort = null;
  }
  refs.streamHandlers.clear();
  refs.streamingMsgRef = null;
  STATE.pending = false;
  // Dynamic import to avoid circular dependency
  import('./overlay.js').then(({ render }) => render());
}

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
