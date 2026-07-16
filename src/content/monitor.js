/**
 * @fileoverview 页面哨兵：点选元素、持久化规则、监听 DOM 变化并触发浏览器通知。
 * 第一版只在目标标签页保持打开时运行，规则判断全部在本地完成。
 */

import { IS_TOP_FRAME, STATE, uid, compactOneLine } from "./state.js";
import { showToast } from "./toast.js";

const STORAGE_KEY = "web2aiMonitors";
const CHECK_INTERVAL_MS = 15000;
let renderCallback = () => void 0;
let mutationObserver = null;
let checkTimer = null;
let debounceTimer = null;
let activePickSession = "";
let activePickCancel = null;
let pickMessageBound = false;

function pageKey(url = location.href) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function readElementText(element) {
  if (!element) return "";
  return compactOneLine(element.innerText || element.textContent || element.getAttribute("value") || "");
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function buildSelector(element) {
  if (element.id) return `#${cssEscape(element.id)}`;
  for (const attr of ["data-testid", "data-id", "data-key", "name", "aria-label"]) {
    const value = element.getAttribute(attr);
    if (value) return `${element.tagName.toLowerCase()}[${attr}="${String(value).replace(/"/g, '\\"')}"]`;
  }
  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

function buildFramePath(element) {
  const path = [];
  let view = element?.ownerDocument?.defaultView;
  try {
    while (view && view !== window.top) {
      const frameElement = view.frameElement;
      if (!frameElement) break;
      path.unshift(buildSelector(frameElement));
      view = frameElement.ownerDocument.defaultView;
    }
  } catch {
    return [];
  }
  return path;
}

function resolveRuleElement(rule) {
  let currentDocument = document;
  try {
    for (const frameSelector of rule.framePath || []) {
      const frame = currentDocument.querySelector(frameSelector);
      currentDocument = frame?.contentDocument;
      if (!currentDocument) return null;
    }
    return currentDocument.querySelector(rule.selector);
  } catch {
    return null;
  }
}

async function readAllRules() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function writeRule(rule) {
  const all = await readAllRules();
  const index = all.findIndex((item) => item.id === rule.id);
  if (index >= 0) all[index] = rule;
  else all.push(rule);
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

async function removeStoredRule(id) {
  const all = await readAllRules();
  await chrome.storage.local.set({ [STORAGE_KEY]: all.filter((item) => item.id !== id) });
}

function numericValue(text) {
  const match = String(text).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function evaluate(rule, element, text) {
  switch (rule.condition) {
    case "present": return Boolean(element);
    case "absent": return !element;
    case "contains": return Boolean(element) && text.includes(rule.operand || "");
    case "number_gt": return Boolean(element) && numericValue(text) > Number(rule.operand);
    case "number_lt": return Boolean(element) && numericValue(text) < Number(rule.operand);
    case "number_eq": return Boolean(element) && numericValue(text) === Number(rule.operand);
    default: return false;
  }
}

function conditionLabel(rule) {
  const labels = {
    present: "元素出现", absent: "元素消失", text_change: "文本变化",
    contains: `文本包含“${rule.operand}”`, number_gt: `数字大于 ${rule.operand}`,
    number_lt: `数字小于 ${rule.operand}`, number_eq: `数字等于 ${rule.operand}`
  };
  return labels[rule.condition] || rule.condition;
}

async function triggerRule(rule, value) {
  rule.lastTriggeredAt = Date.now();
  rule.triggerCount = (rule.triggerCount || 0) + 1;
  rule.history = [{ at: rule.lastTriggeredAt, value: value || "元素不存在" }, ...(rule.history || [])].slice(0, 20);
  await writeRule(rule);
  chrome.runtime.sendMessage({
    type: "MONITOR_TRIGGER",
    rule: { id: rule.id, name: rule.name, url: rule.url, selector: rule.selector },
    message: `${conditionLabel(rule)}：${value || "元素不存在"}`
  }).catch(() => void 0);
}

async function checkRules() {
  if (!IS_TOP_FRAME) return;
  let changed = false;
  for (const rule of STATE.monitorRules) {
    if (!rule.enabled) continue;
    if (rule.frameUrl && rule.frameUrl !== location.href) continue;
    const element = resolveRuleElement(rule);
    const text = readElementText(element);
    rule.lastCheckedAt = Date.now();
    rule.lastValue = text;
    if (rule.condition === "text_change") {
      if (rule.baselineValue !== text) {
        const previous = rule.baselineValue;
        rule.baselineValue = text;
        if (previous !== undefined) await triggerRule(rule, `${previous || "（空）"} → ${text || "（空）"}`);
        changed = true;
      }
      continue;
    }
    const matched = evaluate(rule, element, text);
    if (matched && !rule.lastMatched) await triggerRule(rule, text);
    if (rule.lastMatched !== matched) changed = true;
    rule.lastMatched = matched;
  }
  if (changed) {
    for (const rule of STATE.monitorRules) await writeRule(rule);
    renderCallback();
  }
}

function scheduleCheck() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => checkRules().catch(() => void 0), 500);
}

async function loadMonitorRules() {
  const all = await readAllRules();
  STATE.monitorRules = IS_TOP_FRAME
    ? all.filter((rule) => rule.pageKey === pageKey())
    : all.filter((rule) => rule.frameUrl === location.href);
  renderCallback();
  scheduleCheck();
}

function pickElement(onDone) {
  return new Promise((resolve) => {
    let hovered = null;
    let previousOutline = "";
    let confirmButton = null;
    const listeningDocuments = [];
    const hint = document.createElement("div");
    Object.assign(hint.style, { position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "9px 15px", borderRadius: "999px", background: "#111827", color: "#fff", font: "13px system-ui", pointerEvents: "none" });
    hint.textContent = "悬停目标后点击“选中此元素”或按 Enter · Esc 取消";
    document.documentElement.appendChild(hint);
    const restore = () => { if (hovered) hovered.style.outline = previousOutline; };
    const cleanup = (value) => {
      restore(); hint.remove(); confirmButton?.remove();
      for (const listeningDocument of listeningDocuments) {
        listeningDocument.removeEventListener("mouseover", onOver, true);
        listeningDocument.removeEventListener("keydown", onKey, true);
        listeningDocument.defaultView?.removeEventListener("pointerdown", onSelect, true);
      }
      onDone?.(value);
      resolve(value);
    };
    activePickCancel = () => cleanup(null);
    const onOver = (event) => {
      if (event.target === hint || event.target === confirmButton || event.target.closest?.("#web2ai_overlay_host")) return;
      if (event.target === hovered) return;
      restore(); hovered = event.target; previousOutline = hovered.style.outline;
      hovered.style.outline = "2px solid #2563eb";
      confirmButton?.remove();
      confirmButton = hovered.ownerDocument.createElement("button");
      confirmButton.type = "button";
      confirmButton.textContent = "选中此元素";
      confirmButton.dataset.web2aiMonitorConfirm = "1";
      const rect = hovered.getBoundingClientRect();
      Object.assign(confirmButton.style, {
        position: "fixed",
        left: `${Math.max(4, Math.min(rect.right - 92, hovered.ownerDocument.defaultView.innerWidth - 96))}px`,
        top: `${Math.max(4, rect.top + 4)}px`,
        zIndex: "2147483647",
        height: "28px",
        padding: "0 9px",
        border: "0",
        borderRadius: "7px",
        background: "#2563eb",
        color: "#fff",
        font: "12px system-ui",
        cursor: "pointer",
        boxShadow: "0 4px 12px rgba(0,0,0,.25)"
      });
      confirmButton.addEventListener("pointerdown", (confirmEvent) => {
        confirmEvent.preventDefault();
        confirmEvent.stopImmediatePropagation();
        cleanup(hovered);
      }, true);
      hovered.ownerDocument.documentElement.appendChild(confirmButton);
    };
    const onSelect = (event) => {
      if (!hovered || event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup(hovered);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); cleanup(null); }
      else if (event.key === "Enter" && hovered) { event.preventDefault(); cleanup(hovered); }
    };
    const attachDocument = (currentDocument) => {
      if (!currentDocument || listeningDocuments.includes(currentDocument)) return;
      listeningDocuments.push(currentDocument);
      currentDocument.addEventListener("mouseover", onOver, true);
      currentDocument.addEventListener("keydown", onKey, true);
      // 在 window 的 pointerdown 捕获阶段确认选择，先于站点组件的 click
      // 委托执行，避免重型业务页面 stopImmediatePropagation 后浮层无法恢复。
      currentDocument.defaultView?.addEventListener("pointerdown", onSelect, true);
      for (const frame of currentDocument.querySelectorAll("iframe, frame")) {
        try { attachDocument(frame.contentDocument); } catch { void 0; }
      }
    };
    attachDocument(document);
  });
}

function createMonitorRule() {
  STATE.monitorDraft = {
    name: "",
    condition: "text_change",
    operand: "",
    selector: "",
    targetText: "",
    initialText: ""
  };
  renderCallback();
}

async function selectMonitorTarget() {
  if (!STATE.monitorDraft) createMonitorRule();
  const sessionId = uid();
  STATE.monitorPickSession = sessionId;
  STATE.monitorPicking = true;
  STATE.open = false;
  renderCallback();
  chrome.runtime.sendMessage({ type: "BROADCAST_TO_TAB", payload: { message: { type: "START_MONITOR_PICK", sessionId } } }).catch(() => void 0);
}

async function startMonitorPickInFrame(sessionId) {
  if (!sessionId || activePickSession === sessionId) return;
  activePickSession = sessionId;
  await pickElement((element) => {
    if (activePickSession !== sessionId) return;
    activePickSession = "";
    activePickCancel = null;
    const result = element ? {
      sessionId, selector: buildSelector(element), frameUrl: location.href,
      targetText: readElementText(element).slice(0, 100) || element.tagName.toLowerCase(), initialText: readElementText(element)
    } : { sessionId, cancelled: true, frameUrl: location.href };
    window.top.postMessage({ __web2aiMonitorPick: true, payload: result }, "*");
    chrome.runtime.sendMessage({ type: "MONITOR_PICK_RESULT", payload: result }).catch(() => void 0);
  });
}

function cancelMonitorPickInFrame(sessionId) {
  if (sessionId && activePickSession && sessionId !== activePickSession) return;
  activePickSession = "";
  const cancel = activePickCancel;
  activePickCancel = null;
  cancel?.();
}

function acceptMonitorPickResult(payload) {
  if (!STATE.monitorPicking || !payload?.sessionId) return;
  STATE.monitorPickSession = "";
  STATE.monitorPicking = false;
  STATE.open = true;
  STATE.activePanelTab = "monitor";
  if (payload?.cancelled) { renderCallback(); showToast("已取消选择元素"); return; }
  if (!STATE.monitorDraft) createMonitorRule();
  STATE.monitorDraft.selector = payload.selector;
  STATE.monitorDraft.frameId = payload.frameId || 0;
  STATE.monitorDraft.frameUrl = payload.frameUrl || location.href;
  STATE.monitorDraft.targetText = payload.targetText;
  STATE.monitorDraft.initialText = payload.initialText;
  if (!STATE.monitorDraft.name) STATE.monitorDraft.name = payload.targetText?.slice(0, 30) || document.title;
  renderCallback();
}

async function saveMonitorRule() {
  const draft = STATE.monitorDraft;
  if (!draft?.selector) { showToast("请先选择要监控的页面元素"); return; }
  if (!String(draft.name).trim()) { showToast("请填写监控名称"); return; }
  if ((draft.condition === "contains" || draft.condition.startsWith("number_")) && !String(draft.operand).trim()) {
    showToast(draft.condition === "contains" ? "请填写关键词" : "请填写数字阈值");
    return;
  }
  const rule = {
    id: uid(), name: String(draft.name).trim(), url: location.href, pageKey: pageKey(), selector: draft.selector,
    framePath: Array.isArray(draft.framePath) ? draft.framePath : [],
    frameId: draft.frameId || 0, frameUrl: draft.frameUrl || location.href,
    condition: draft.condition, operand: String(draft.operand || "").trim(), enabled: true, createdAt: Date.now(),
    baselineValue: draft.initialText, lastValue: draft.initialText, lastMatched: draft.condition === "present"
  };
  STATE.monitorRules.unshift(rule);
  STATE.monitorDraft = null;
  await writeRule(rule);
  renderCallback();
  showToast("监控已创建；目标标签页保持打开时生效");
}

function cancelMonitorRule() {
  STATE.monitorDraft = null;
  renderCallback();
}

async function toggleMonitorRule(id) {
  const rule = STATE.monitorRules.find((item) => item.id === id);
  if (!rule) return;
  rule.enabled = !rule.enabled;
  rule.lastMatched = false;
  await writeRule(rule);
  renderCallback();
  if (rule.enabled) scheduleCheck();
}

async function deleteMonitorRule(id) {
  STATE.monitorRules = STATE.monitorRules.filter((item) => item.id !== id);
  await removeStoredRule(id);
  renderCallback();
}

async function checkMonitorNow(id) {
  if (id) {
    const otherRules = STATE.monitorRules;
    STATE.monitorRules = otherRules.filter((rule) => rule.id === id);
    await checkRules();
    STATE.monitorRules = otherRules;
  } else await checkRules();
  showToast("检查完成");
  renderCallback();
}

function locateMonitorRule(id) {
  const rule = STATE.monitorRules.find((item) => item.id === id);
  const element = rule ? resolveRuleElement(rule) : null;
  if (!element) { showToast("未找到监控元素，页面结构可能已变化"); return; }
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  const oldOutline = element.style.outline;
  element.style.outline = "3px solid #ef4444";
  setTimeout(() => { element.style.outline = oldOutline; }, 3000);
}

function initMonitor(onRender) {
  renderCallback = onRender || renderCallback;
  if (IS_TOP_FRAME && !pickMessageBound) {
    pickMessageBound = true;
    window.addEventListener("message", (event) => {
      if (!event.data?.__web2aiMonitorPick) return;
      acceptMonitorPickResult(event.data.payload);
      chrome.runtime.sendMessage({
        type: "BROADCAST_TO_TAB",
        payload: { message: { type: "CANCEL_MONITOR_PICK", sessionId: event.data.payload?.sessionId } }
      }).catch(() => void 0);
    });
  }
  loadMonitorRules().catch(() => void 0);
  mutationObserver = new MutationObserver(scheduleCheck);
  const observeDocument = (currentDocument) => {
    if (!currentDocument?.documentElement) return;
    mutationObserver.observe(currentDocument.documentElement, { childList: true, subtree: true, characterData: true });
    for (const frame of currentDocument.querySelectorAll("iframe, frame")) {
      try { observeDocument(frame.contentDocument); } catch { void 0; }
      frame.addEventListener("load", () => {
        try { observeDocument(frame.contentDocument); scheduleCheck(); } catch { void 0; }
      });
    }
  };
  observeDocument(document);
  checkTimer = setInterval(() => checkRules().catch(() => void 0), CHECK_INTERVAL_MS);
}

const reloadMonitorRules = loadMonitorRules;
export { initMonitor, reloadMonitorRules, createMonitorRule, selectMonitorTarget, startMonitorPickInFrame, cancelMonitorPickInFrame, acceptMonitorPickResult, saveMonitorRule, cancelMonitorRule, toggleMonitorRule, deleteMonitorRule, checkMonitorNow, locateMonitorRule, conditionLabel };
