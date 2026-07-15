/**
 * @fileoverview AI 对话浮层 UI。
 *
 * 职责：
 * - 渲染侧边栏聊天面板（Shadow DOM 隔离样式）
 * - 管理对话消息列表、输入框、流式渲染
 * - 上下文片段列表渲染（按表格分组）
 * - 可拖拽的浮动启动器（Launcher FAB）
 * - 面板最大化/还原、ESC 关闭等交互
 *
 * 通信流程：
 * content script → messaging.js (Port) → background.js (fetch SSE) → messaging.js → scheduleRender
 */

import { DEBUG, IS_TOP_FRAME, STATE, COL_SEPARATOR, Z_INDEX, TABLE_UI_Z_INDEX, uid, normalizeText, compactOneLine, clamp, refs } from './state.js';
import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { openOptionsPage, streamChat, stopGeneration, sendToBackground } from './messaging.js';
import { addContextSnippet, removeContext, clearAll, buildContextBlock, extractPageText } from './context.js';
import { calculateContextBudget, estimateTokens, selectContextsWithinTokenBudget } from './token-budget.js';
import { tableGroupToCsv, tableGroupToMarkdown } from './table-export.js';
import { buildOnboardingPrompt, createFallbackOnboarding, parseOnboardingResponse } from './onboarding.js';
import { highlightRow, removePinnedRowOverlay, syncRowCheckboxState, updateBatchBar, hideTableRowFab, ensureTableRowFab, setTableSelectionEnabled } from './table.js';
import { showToast } from './toast.js';

const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; right: 0; top: 0; bottom: 0; width: 420px; height: 100vh; pointer-events: auto; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .wrap.max { left: 0; right: 0; width: 100vw; }
    .card { height: 100%; display: flex; flex-direction: column; background: rgba(255,255,255,0.98); border-left: 1px solid rgba(0,0,0,0.12); overflow: hidden; box-shadow: 0 12px 36px rgba(0,0,0,0.22); backdrop-filter: blur(10px); }
    .wrap.max .card { border-left: none; box-shadow: none; }
    .hidden { display: none; }
    .header { display: flex; align-items: center; gap: 6px; padding: 10px 10px; border-bottom: 1px solid rgba(0,0,0,0.08); }
    .title { font-weight: 650; font-size: 13px; color: #111827; flex: 1; }
    .header .btn-primary { font-weight: 600; }
    .btn { height: 28px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.12); background: #fff; color: #111827; padding: 0 10px; cursor: pointer; font-size: 12px; }
    .btn.primary { background: #111827; color: #fff; border-color: #111827; }
    .btn.danger { background: #fff; color: #b91c1c; border-color: rgba(185,28,28,0.35); }
    .body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 10px; overflow: hidden; }
    .body.max { flex-direction: row; }
    .section { border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; overflow: hidden; background: #fff; display: flex; flex-direction: column; min-height: 0; }
    .sectionHead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(248,250,252,0.9); border-bottom: 1px solid rgba(0,0,0,0.06); }
    .sectionTitle { font-size: 12px; font-weight: 650; color: #111827; flex: 1; }
    .sectionBody { padding: 8px 10px; max-height: 30vh; overflow: auto; flex: 1; min-height: 0; }
    .body.max .sectionBody { max-height: none; }
    .body.max .contextSec { flex: 0 0 340px; width: 340px; }
    .body.max .chatSec { flex: 1; }
    .tableGroupLabel { font-size: 11px; font-weight: 650; color: #dc2626; padding: 4px 0 2px 0; margin-top: 4px; }
    .tableGroupLabel:first-child { margin-top: 0; }
    .contextItem { position: relative; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 6px 6px; margin-bottom: 6px; background: #fff; }
    .contextMeta { font-size: 11px; color: #6b7280; margin-bottom: 4px; padding-right: 28px; }
    .contextText { font-size: 12px; color: #111827; white-space: pre-wrap; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .contextOmitted { font-size: 11px; color: #6b7280; margin-top: 6px; }
    .ctxRemove { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12); background: #fff; color: #111827; cursor: pointer; font-size: 14px; line-height: 20px; padding: 0; }
    .ctxRemove:hover { background: rgba(0,0,0,0.04); }
    .chatSec { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .chat { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; background: #fff; }
    .bubble { border-radius: 12px; padding: 8px 10px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: break-word; }
    .bubble.user { background: #111827; color: #fff; align-self: flex-end; }
    .bubble.assistant { background: #f3f4f6; color: #111827; align-self: flex-start; border: 1px solid rgba(0,0,0,0.06); }
    .bubble.assistant p { margin: 0 0 6px 0; }
    .bubble.assistant p:last-child { margin-bottom: 0; }
    .bubble.assistant table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 11px; }
    .bubble.assistant th, .bubble.assistant td { border: 1px solid rgba(0,0,0,0.15); padding: 4px 6px; text-align: left; }
    .bubble.assistant th { background: rgba(0,0,0,0.04); font-weight: 650; }
    .bubble.assistant pre { background: rgba(0,0,0,0.06); border-radius: 8px; padding: 8px; overflow-x: auto; margin: 6px 0; font-size: 11px; }
    .bubble.assistant code { font-family: "SF Mono", "Menlo", "Monaco", monospace; font-size: 11px; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 4px; }
    .bubble.assistant pre code { background: none; padding: 0; }
    .bubble.assistant ul, .bubble.assistant ol { margin: 4px 0; padding-left: 20px; }
    .bubble.assistant li { margin: 2px 0; }
    .bubble.assistant h2, .bubble.assistant h3, .bubble.assistant h4 { margin: 8px 0 4px 0; font-weight: 650; }
    .bubble.assistant h2 { font-size: 14px; }
    .bubble.assistant h3 { font-size: 13px; }
    .bubble.assistant h4 { font-size: 12px; }
    .bubble.assistant a { color: #2563eb; text-decoration: underline; }
    .onboarding { border: 1px solid rgba(59,130,246,.2); background: #f8fbff; border-radius: 12px; padding: 12px; color: #111827; }
    .onboardingWelcome { font-size: 14px; font-weight: 650; margin-bottom: 6px; }
    .onboardingSummary { font-size: 12px; line-height: 1.55; color: #374151; }
    .suggestions { display: grid; gap: 7px; margin-top: 10px; }
    .suggestion { text-align: left; border: 1px solid rgba(59,130,246,.25); background: #fff; color: #1d4ed8; border-radius: 10px; padding: 8px 10px; cursor: pointer; }
    .suggestion:hover { background: #eff6ff; }
    .suggestionLabel { display: block; font-size: 12px; font-weight: 650; }
    .suggestionReason { display: block; margin-top: 2px; color: #6b7280; font-size: 10px; }
    .onboardingHint { margin-top: 9px; color: #6b7280; font-size: 11px; }
    .composer { display: flex; gap: 10px; padding: 10px; border-top: 1px solid rgba(0,0,0,0.08); background: rgba(248,250,252,0.9); }
    textarea { flex: 1; resize: none; height: 92px; border-radius: 12px; border: 1px solid rgba(0,0,0,0.14); padding: 8px 10px; font-size: 12px; outline: none; background: #fff; color: #111827; }
    textarea:focus { border-color: rgba(59,130,246,0.7); box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
    .composerActions { width: 92px; display: flex; flex-direction: column; gap: 8px; }
    .composerActions .btn { width: 100%; }
    .backdrop { position: fixed; inset: 0; background: transparent; pointer-events: none; }
  `;

function scheduleRender() {
  if (refs.renderScheduled) return;
  refs.renderScheduled = true;
  requestAnimationFrame(() => {
    refs.renderScheduled = false;
    if (refs.streamingMsgRef && refs.overlayShadow) {
      const chatList = refs.overlayShadow.getElementById("web2ai_chat_list");
      if (chatList) {
        const lastBubble = chatList.lastElementChild;
        if (lastBubble && lastBubble.classList.contains("assistant")) {
          lastBubble.innerHTML = renderMarkdown(refs.streamingMsgRef.content);
          chatList.scrollTop = chatList.scrollHeight;
          return;
        }
      }
    }
    render();
  });
}

function ensureOverlay() {
  if (refs.overlayHost) return;
  refs.overlayHost = el("div", {
    id: "web2ai_overlay_host",
    style: { position: "fixed", inset: "0", zIndex: String(Number(Z_INDEX) - 1), pointerEvents: "none" }
  });
  refs.overlayShadow = refs.overlayHost.attachShadow({ mode: "open" });
  document.documentElement.appendChild(refs.overlayHost);
  render();
}

function render() {
  if (!IS_TOP_FRAME) return;
  ensureOverlay();
  if (refs.launcherFab) {
    refs.launcherFab.style.display = !STATE.open && STATE.launcherVisible ? "flex" : "none";
  }
  // 更新数据统计气泡
  if (refs.launcherBadge && refs.launcherFab) {
    const tableCount = STATE.tableGroups.length;
    const rowCount = STATE.tableGroups.reduce((sum, g) => sum + g.rows.length, 0);
    if (!STATE.open && STATE.launcherVisible && (tableCount > 0 || STATE.contexts.length > 0)) {
      const label = tableCount > 0
        ? `${tableCount}个表格，${rowCount}条数据`
        : `${STATE.contexts.length}条数据`;
      refs.launcherBadge.textContent = label;
      const fabLeft = parseInt(refs.launcherFab.style.left, 10);
      const fabTop = parseInt(refs.launcherFab.style.top, 10);
      const fabSize = refs.launcherFab.offsetWidth || 44;
      refs.launcherBadge.style.left = `${Math.max(8, fabLeft + fabSize)}px`;
      refs.launcherBadge.style.top = `${Math.max(8, fabTop)}px`;
      refs.launcherBadge.style.transform = "translate(-100%, -100%)";
      refs.launcherBadge.style.display = "block";
      refs.launcherBadge.style.zIndex = Z_INDEX;
      refs.launcherBadge.style.opacity = "1";
      refs.launcherBadge.style.transform = "translate(-100%, -100%) scale(1)";
    } else {
      refs.launcherBadge.style.opacity = "0";
      refs.launcherBadge.style.transform = "translate(-100%, -100%) scale(0.9)";
      setTimeout(() => { if (refs.launcherBadge) refs.launcherBadge.style.display = "none"; }, 250);
    }
  }
  // 最大化时将所有浮动 UI 的 z-index 降到聊天面板下方，防止遮挡
  const isMaximized = STATE.open && STATE.maximized;
  const floatingZIndex = isMaximized ? "1" : Z_INDEX;
  const tableUiZIndex = isMaximized ? "1" : TABLE_UI_Z_INDEX;
  if (refs.launcherFab) refs.launcherFab.style.zIndex = floatingZIndex;
  if (refs.batchBar) refs.batchBar.style.zIndex = tableUiZIndex;
  if (refs.tableRowFab) refs.tableRowFab.style.zIndex = tableUiZIndex;
  if (refs.inlineRowFab) refs.inlineRowFab.style.zIndex = tableUiZIndex;
  for (const node of refs.pinnedRowOverlays.values()) {
    node.style.zIndex = tableUiZIndex;
  }

  const wrap = el("div", {
    class: `wrap ${STATE.open ? "" : "hidden"}${STATE.maximized ? " max" : ""}`
  });
  const backdrop = el("div", {
    class: `backdrop ${STATE.open ? "" : "hidden"}`
  });

  const header = el("div", { class: "header" }, [
    el("div", { class: "title" }, ["采"]),
    el(
      "button",
      {
        class: "btn primary",
        style: { fontSize: "11px", padding: "4px 10px" },
        onClick: () => toggleMaximized()
      },
      [STATE.maximized ? "还原" : "最大化"]
    ),
    el(
      "button",
      {
        class: "btn",
        onClick: () => openOptionsPage()
      },
      ["设置"]
    ),
    el(
      "button",
      {
        class: "btn danger",
        disabled: STATE.pending ? true : null,
        onClick: () => clearAll()
      },
      ["全部清空"]
    ),
    el(
      "button",
      {
        class: "btn",
        style: { width: "28px", padding: "0", fontSize: "16px", lineHeight: "26px" },
        onClick: () => setOpen(false)
      },
      ["\u00d7"]
    )
  ]);

  function renderContextItem(c) {
    const fullText = normalizeText(c.text);
    const displayLimit = 140;
    const shownText = fullText.length > displayLimit ? fullText.slice(0, displayLimit) : fullText;
    let omittedHint = "";
    if (fullText.length > displayLimit) omittedHint = `剩余 ${fullText.length - displayLimit} 字符已省略`;
    else {
      const lineCount = fullText.split("\n").length;
      if (lineCount > 2) omittedHint = `剩余 ${lineCount - 2} 行已省略`;
    }
    const tipLimit = 100;
    const tipText =
      fullText.length > tipLimit
        ? `${fullText.slice(0, tipLimit)}…（已省略 ${fullText.length - tipLimit} 字符）`
        : fullText;
    return el("div", { class: "contextItem" }, [
      el("input", {
        type: "checkbox",
        checked: c.enabled !== false ? true : null,
        title: c.enabled !== false ? "发送时包含此项" : "此项不会发送给 AI",
        style: { position: "absolute", right: "30px", top: "8px" },
        onChange: (event) => {
          c.enabled = Boolean(event.target.checked);
          render();
        }
      }),
      el(
        "button",
        { class: "ctxRemove", title: "移除", onClick: () => removeContext(c.id) },
        ["×"]
      ),
      el("div", { class: "contextMeta" }, [
        el("span", {}, [
          c.kind === "table-header"
            ? el("span", { style: { color: "#dc2626", fontWeight: "600" } }, ["表结构说明"])
            : c.kind === "table-row" ? "表格内容" : c.kind
        ]),
        `${c.lineInfo?.startLine && c.lineInfo?.endLine
            ? ` · L${c.lineInfo.startLine}-${c.lineInfo.endLine}`
            : ""
        } · ${new Date(c.createdAt).toLocaleString()}`
      ]),
      el("div", { class: "contextText", title: tipText }, [shownText]),
      omittedHint ? el("div", { class: "contextOmitted" }, [omittedHint]) : null,
      null
    ]);
  }

  function renderTableGroups() {
    const groups = STATE.tableGroups;
    if (!groups.length) {
      return [el("div", { style: { fontSize: "12px", color: "#6b7280" } }, ["还没有上下文，选中文本或右键添加。"])];
    }
    const els = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const rowCount = g.rows.length;
      const label = g.header
        ? `表格 ${g.tableNumber}（${rowCount} 条）`
        : `表格 ${g.tableNumber}（无表头，${rowCount} 条）`;
      els.push(el("div", { class: "tableGroupLabel", style: { display: "flex", alignItems: "center", gap: "6px" } }, [
        el("span", { style: { flex: "1" } }, [label]),
        el("button", { class: "btn", style: { padding: "0 6px", height: "22px", fontSize: "10px" }, onClick: () => downloadTableGroup(g, "markdown", g.tableNumber - 1) }, ["MD"]),
        el("button", { class: "btn", style: { padding: "0 6px", height: "22px", fontSize: "10px" }, onClick: () => downloadTableGroup(g, "csv", g.tableNumber - 1) }, ["CSV"])
      ]));
      if (g.header) {
        els.push(renderContextItem(g.header));
      }
      for (const row of g.rows) {
        els.push(renderContextItem(row));
      }
    }
    return els;
  }

  const tableCount = STATE.tableGroups.length;
  const rowCount = STATE.tableGroups.reduce((sum, g) => sum + g.rows.length, 0);
  const contextSection = el("div", { class: "section contextSec" }, [
    el("div", { class: "sectionHead" }, [
      el("div", { class: "sectionTitle" }, [`上下文（${tableCount} 个表格，共 ${rowCount} 条）`])
    ]),
    el("div", { class: "sectionBody" }, renderTableGroups())
  ]);

  const chatSection = el("div", { class: "section chatSec" }, [
    el("div", { class: "sectionHead" }, [
      el("div", { class: "sectionTitle" }, ["对话"])
    ]),
    el(
      "div",
      { class: "chat", id: "web2ai_chat_list" },
      STATE.messages.length
        ? STATE.messages.map((m) => {
            const bubble = el("div", { class: `bubble ${m.role}` });
            if (m.role === "assistant") {
              bubble.innerHTML = renderMarkdown(m.content);
            } else {
              bubble.textContent = m.content;
            }
            return bubble;
          })
        : STATE.onboarding
          ? [renderOnboarding(STATE.onboarding)]
          : [el("div", { style: { fontSize: "12px", color: "#6b7280" } }, ["输入问题开始对话；也可以直接点击“问一下”获取分析建议。"])]
    ),
    el("div", { class: "composer" }, [
      el("textarea", {
        id: "web2ai_input",
        placeholder: "问点什么…（Enter 发送，Shift+Enter 换行）"
      }),
      el("div", { class: "composerActions" }, [
        el(
          "button",
          {
            class: "btn primary",
            disabled: STATE.pending ? true : null,
            onClick: () => onSend(),
            style: STATE.pending ? { display: "none" } : {}
          },
          ["问一下"]
        ),
        el(
          "button",
          {
            class: "btn danger",
            onClick: () => stopGeneration(),
            style: STATE.pending ? {} : { display: "none" }
          },
          ["停止生成"]
        ),
        el(
          "button",
          {
            class: "btn",
            disabled: STATE.pending ? true : null,
            onClick: () => clearDraftInput()
          },
          ["清空输入"]
        )
      ])
    ])
  ]);

  const body = el("div", { class: `body${STATE.maximized ? " max" : ""}` }, [
    contextSection,
    chatSection
  ]);
  const card = el("div", { class: "card" }, [header, body]);
  wrap.appendChild(card);

  refs.overlayShadow.innerHTML = "";
  refs.overlayShadow.appendChild(el("style", {}, [OVERLAY_CSS]));
  refs.overlayShadow.appendChild(backdrop);
  refs.overlayShadow.appendChild(wrap);

  const input = refs.overlayShadow.getElementById("web2ai_input");
  if (input) {
    input.value = STATE.draftText;
    input.addEventListener("input", (e) => {
      STATE.draftText = e.target.value ?? "";
      if (String(STATE.draftText).trim()) STATE.suppressAutoSuggest = false;
      STATE.lastInputCursor = {
        start: e.target.selectionStart ?? STATE.draftText.length,
        end: e.target.selectionEnd ?? STATE.draftText.length
      };
    });
    const updateCursor = (e) => {
      STATE.lastInputCursor = {
        start: e.target.selectionStart ?? STATE.draftText.length,
        end: e.target.selectionEnd ?? STATE.draftText.length
      };
    };
    input.addEventListener("click", updateCursor);
    input.addEventListener("keyup", updateCursor);
    input.addEventListener("select", updateCursor);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
  }

  const chatList = refs.overlayShadow.getElementById("web2ai_chat_list");
  if (chatList) {
    chatList.scrollTop = chatList.scrollHeight;
  }
}

function sliceRecentRounds(messages) {
  const rounds = [];
  let i = messages.length - 1;
  while (i >= 0) {
    if (messages[i].role === "assistant") {
      const assistant = messages[i];
      const user = i > 0 && messages[i - 1].role === "user" ? messages[i - 1] : null;
      if (user) {
        rounds.unshift([user, assistant]);
        i -= 2;
      } else {
        rounds.unshift([null, assistant]);
        i--;
      }
    } else if (messages[i].role === "user") {
      rounds.unshift([messages[i], null]);
      i--;
    } else {
      i--;
    }
  }

  const take3 = rounds.slice(-3);
  const charCount3 = take3.reduce((sum, [u, a]) => sum + (u?.content?.length || 0) + (a?.content?.length || 0), 0);

  let selectedRounds;
  if (charCount3 < 15000 && rounds.length >= 5) {
    selectedRounds = rounds.slice(-5);
  } else {
    selectedRounds = take3;
  }

  const result = [];
  for (const [user, assistant] of selectedRounds) {
    if (user) result.push({ ...user });
    if (assistant) result.push({ ...assistant });
  }
  return result;
}

async function sendText(rawText, opts = {}) {
  if (!IS_TOP_FRAME) return;
  ensureOverlay();
  const text = normalizeText(rawText);
  if (!text) return;
  if (STATE.pending) return;
  STATE.onboarding = null;

  const pendingUserMessage = { role: "user", content: text, ts: Date.now() };
  STATE.messages.push(pendingUserMessage);
  STATE.pending = true;
  render();

  // hoist to be accessible in catch block (some JS environments scope try/catch separately)
  let requestMessages = [];

  try {
    requestMessages = [];

    if (opts.headersOnly) {
      requestMessages.push({ role: "user", content: text });
      DEBUG && console.log(`[web2ai] sendText headersOnly mode, prompt length=${text.length}`);
    } else {
      const isFirstTurn = STATE.messages.length <= 1;
      const recentMessages = sliceRecentRounds(STATE.messages);
      const latestUserTs = STATE.messages.filter((m) => m.role === "user").pop()?.ts;
      const historyMessages = recentMessages.map((m) => {
          if (m.role === "user") {
            const isLatest = m.ts === latestUserTs;
            return isLatest
              ? { role: "user", content: `USER_INPUT:\n${m.content}` }
              : { role: "user", content: m.content };
          }
          return { role: m.role, content: m.content };
        });
      const settingsResp = await sendToBackground({ type: "GET_SETTINGS" });
      const settings = settingsResp?.data || {};
      const budget = calculateContextBudget({
        contextWindow: Math.max(8192, Number(settings.contextWindow) || 64000),
        maxOutputTokens: Math.max(256, Number(settings.maxOutputTokens) || 4096),
        messages: historyMessages
      });
      const enabledContexts = STATE.contexts.filter((context) => context.enabled !== false);
      const contextTokens = enabledContexts.reduce((sum, context) => sum + estimateTokens(context.text) + 24, 0);
      const selection = selectContextsWithinTokenBudget(enabledContexts, budget.availableTokens);
      const contextsToUse = selection.contexts;
      if (contextsToUse.length < enabledContexts.length) {
        showToast(`上下文超出模型预算，已保留表头和最近数据（${contextsToUse.length}/${enabledContexts.length} 条）`);
      }
      DEBUG && console.log(`[web2ai] token budget context=${contextTokens} available=${budget.availableTokens} selected=${contextsToUse.length}`);
      const contextBlock = buildContextBlock(contextsToUse, !isFirstTurn);
      if (contextBlock) requestMessages.push({ role: "system", content: contextBlock });
      requestMessages.push(...historyMessages);

      DEBUG && console.log(`[web2ai] sendText requestMessages=${requestMessages.length}`, JSON.stringify({
        systemLen: requestMessages[0]?.content?.length || 0,
        historyRounds: recentMessages.length,
        totalMessages: requestMessages.length,
        isFirstTurn
      }));
    }

    const assistantMsg = {
      role: "assistant",
      id: uid(),
      content: "",
      ts: Date.now()
    };
    STATE.messages.push(assistantMsg);
    refs.streamingMsgRef = assistantMsg;
    render();

    await streamChat({
      messages: requestMessages,
      onChunk: (delta) => {
        assistantMsg.content += delta;
        scheduleRender();
      }
    });

    assistantMsg.content = normalizeText(assistantMsg.content) || "(empty response)";
    refs.streamingMsgRef = null;
    render();
  } catch (e) {
    const errMsg = String(e?.message ?? e);
    const partialAssistant = refs.streamingMsgRef;
    // 已收到任何内容时绝不整请求重试，避免重复回答和重复计费。
    if (partialAssistant?.content) {
      partialAssistant.content = `${normalizeText(partialAssistant.content)}\n\n[连接已中断：${errMsg}]`;
      refs.streamingMsgRef = null;
      showToast("回答已部分生成，连接中断后未自动重试");
      render();
      return;
    }
    DEBUG && console.log(`[web2ai] sendText failed before first token, retrying once: ${errMsg}`);
    try {
      STATE.messages.pop();
      const retryAssistantMsg = {
        role: "assistant",
        id: uid(),
        content: "",
        ts: Date.now()
      };
      STATE.messages.push(retryAssistantMsg);
      refs.streamingMsgRef = retryAssistantMsg;
      render();
      await streamChat({
        messages: requestMessages,
        onChunk: (delta) => {
          retryAssistantMsg.content += delta;
          scheduleRender();
        }
      });
      retryAssistantMsg.content = normalizeText(retryAssistantMsg.content) || "(empty response)";
      refs.streamingMsgRef = null;
      render();
    } catch (e2) {
      refs.streamingMsgRef = null;
      STATE.messages.push({
        role: "assistant",
        content: `请求失败：${String(e2?.message ?? e2)}`,
        ts: Date.now()
      });
    }
  } finally {
    refs.streamingMsgRef = null;
    STATE.pending = false;
    render();
  }
}

async function onSend() {
  if (!IS_TOP_FRAME) return;
  ensureOverlay();
  const raw = STATE.draftText;
  const hasInput = !!normalizeText(raw);
  const enabledContexts = STATE.contexts.filter((context) => context.enabled !== false);
  const hasContext = enabledContexts.length > 0;
  const isFirstTurn = STATE.messages.length === 0;

  if (!isFirstTurn && !hasInput) {
    showToast("请填写需要问的问题");
    return;
  }

  if (STATE.pending) return;
  STATE.draftText = "";
  STATE.lastInputCursor = { start: 0, end: 0 };
  applyDraftToInputIfPresent();

  if (isFirstTurn && !hasInput) {
    if (!hasContext) {
      showToast("请先选择列表数据加入上下文");
      return;
    }
    const enabledGroups = STATE.tableGroups.map((group) => ({
      ...group,
      header: group.header?.enabled !== false ? group.header : null,
      rows: group.rows.filter((row) => row.enabled !== false)
    })).filter((group) => group.header || group.rows.length);
    const hasData = enabledGroups.length > 0;
    if (hasData) {
      await generateOnboarding(enabledGroups);
    } else {
      showToast("请先选择列表数据加入上下文");
    }
    return;
  } else {
    await sendText(raw);
  }
}

function renderOnboarding(onboarding) {
  return el("div", { class: "onboarding" }, [
    el("div", { class: "onboardingWelcome" }, [onboarding.welcome]),
    el("div", { class: "onboardingSummary" }, [onboarding.summary]),
    el("div", { class: "suggestions" }, onboarding.suggestions.map((suggestion) =>
      el("button", {
        class: "suggestion",
        title: suggestion.prompt,
        onClick: () => {
          STATE.draftText = suggestion.prompt;
          STATE.lastInputCursor = { start: suggestion.prompt.length, end: suggestion.prompt.length };
          applyDraftToInputIfPresent();
          refs.overlayShadow?.getElementById("web2ai_input")?.focus();
        }
      }, [
        el("span", { class: "suggestionLabel" }, [suggestion.label]),
        el("span", { class: "suggestionReason" }, [suggestion.reason])
      ])
    )),
    el("div", { class: "onboardingHint" }, [onboarding.freeInputHint])
  ]);
}

async function generateOnboarding(groups) {
  if (STATE.pending) return;
  STATE.pending = true;
  STATE.onboarding = null;
  render();
  try {
    const pages = new Set(groups.flatMap((group) => group.rows.map((row) => row.pageIndex).filter(Boolean)));
    const prompt = buildOnboardingPrompt(groups, { pageCount: Math.max(1, pages.size) });
    const resp = await sendToBackground({
      type: "AI_CHAT",
      payload: {
        messages: [
          { role: "system", content: "You generate structured onboarding suggestions for a data analysis UI. Return valid JSON only." },
          { role: "user", content: prompt }
        ]
      }
    });
    if (!resp?.ok) throw new Error(resp?.error || "Onboarding request failed");
    STATE.onboarding = parseOnboardingResponse(resp.data?.content);
  } catch (error) {
    DEBUG && console.log(`[web2ai] onboarding fallback: ${String(error?.message ?? error)}`);
    STATE.onboarding = createFallbackOnboarding(groups);
    showToast("智能建议暂时不可用，已提供常用分析入口");
  } finally {
    STATE.pending = false;
    render();
  }
}

function applyDraftToInputIfPresent() {
  const input = refs.overlayShadow?.getElementById("web2ai_input");
  if (!input) return;
  if (input.value !== STATE.draftText) input.value = STATE.draftText;
  if (STATE.lastInputCursor?.start != null && STATE.lastInputCursor?.end != null) {
    try {
      input.setSelectionRange(STATE.lastInputCursor.start, STATE.lastInputCursor.end);
    } catch {
      void 0;
    }
  }
}

function insertIntoDraft(text) {
  const cursor = STATE.lastInputCursor;
  const start = typeof cursor?.start === "number" ? cursor.start : STATE.draftText.length;
  const end = typeof cursor?.end === "number" ? cursor.end : STATE.draftText.length;
  STATE.draftText = STATE.draftText.slice(0, start) + text + STATE.draftText.slice(end);
  const pos = start + text.length;
  STATE.lastInputCursor = { start: pos, end: pos };
  applyDraftToInputIfPresent();
}

function clearDraftInput() {
  STATE.draftText = "";
  STATE.lastInputCursor = { start: 0, end: 0 };
  STATE.suppressAutoSuggest = true;
  applyDraftToInputIfPresent();
}

function setOpen(open) {
  STATE.open = open;
  if (IS_TOP_FRAME) {
    ensureOverlay();
    render();
  }
}

function setMaximized(max) {
  STATE.maximized = Boolean(max);
  chrome.storage.sync.set({ panelMaximized: STATE.maximized }).catch(() => void 0);
  if (STATE.maximized) STATE.open = true;
  render();
}

function toggleMaximized() {
  setMaximized(!STATE.maximized);
}

function ensureHotkeys() {
  if (refs.hotkeysBound) return;
  refs.hotkeysBound = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && STATE.open) {
        if (STATE.maximized) setMaximized(false);
        else setOpen(false);
      }
    },
    true
  );
}

function ensureLauncherFab() {
  if (refs.launcherFab) return;

  const size = 44;
  const padding = 16;
  const defaultLeft = () => Math.max(padding, window.innerWidth - padding - size * 2);
  const defaultTop = () => Math.max(padding, window.innerHeight - 120 - size);
  const clampLeft = (x) => clamp(x, padding, window.innerWidth - size * 2 - padding);
  const clampTop = (y) => clamp(y, padding, window.innerHeight - size * 1.5 - padding);

  refs.launcherFab = el("div", {
    id: "web2ai_launcher_fab",
    style: {
      position: "fixed",
      left: `${defaultLeft()}px`,
      top: `${defaultTop()}px`,
      width: "auto",
      height: "auto",
      borderRadius: "24px",
      background: "rgba(59,130,246,0.95)",
      border: "1px solid rgba(59,130,246,0.6)",
      boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
      zIndex: Z_INDEX,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      touchAction: "none",
      padding: "8px 10px 6px 10px",
      gap: "2px",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    }
  });

  refs.launcherFab.innerHTML =
    '<button type="button" data-web2ai-close-launcher aria-label="关闭 Chat 图标" title="关闭" style="position:absolute;right:-7px;top:-7px;width:18px;height:18px;padding:0;border:1px solid rgba(255,255,255,.85);border-radius:50%;background:#374151;color:#fff;font:700 14px/16px system-ui;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>' +
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 10.5V9.2C7.5 6.77 9.47 4.8 11.9 4.8H12.1C14.53 4.8 16.5 6.77 16.5 9.2V10.5" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/><path d="M6.8 10.5H17.2C18.42 10.5 19.4 11.48 19.4 12.7V15.9C19.4 18.33 17.43 20.3 15 20.3H9C6.57 20.3 4.6 18.33 4.6 15.9V12.7C4.6 11.48 5.58 10.5 6.8 10.5Z" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/><path d="M9.4 14.1H9.41" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/><path d="M14.6 14.1H14.61" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/><path d="M9.2 17.1C10.2 17.8 11.1 18.1 12 18.1C12.9 18.1 13.8 17.8 14.8 17.1" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<span style="color:#fff;font-size:10px;font-weight:700;line-height:1;white-space:nowrap;">采（问AI）</span>';

  let suppressNextClick = false;
  let drag = null;
  let currentPos = { left: defaultLeft(), top: defaultTop() };

  const closeButton = refs.launcherFab.querySelector("[data-web2ai-close-launcher]");
  closeButton?.addEventListener("pointerdown", (e) => e.stopPropagation());
  closeButton?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    STATE.launcherVisible = false;
    setTableSelectionEnabled(false);
    chrome.storage.sync.set({ launcherHidden: true }).catch(() => void 0);
    render();
    showToast("对话能力已关闭。点击浏览器工具栏中的插件扩展图标，可再次启动对话能力。", 4000);
  });

  const applyPos = (pos) => {
    const left = clampLeft(pos.left);
    const top = clampTop(pos.top);
    currentPos = { left, top };
    refs.launcherFab.style.left = `${left}px`;
    refs.launcherFab.style.top = `${top}px`;
    if (refs.launcherBadge && refs.launcherBadge.style.display !== "none") {
       const fabSize = refs.launcherFab.offsetWidth || 44;
       refs.launcherBadge.style.left = `${Math.max(8, left + fabSize)}px`;
       refs.launcherBadge.style.top = `${Math.max(8, top)}px`;
     }
  };

  chrome.storage.sync
    .get(["launcherPos", "panelMaximized"])
    .then((data) => {
      const p = data?.launcherPos;
      if (p && typeof p.left === "number" && typeof p.top === "number") applyPos(p);
      if (typeof data?.panelMaximized === "boolean") STATE.maximized = data.panelMaximized;
    })
    .catch(() => void 0);

  window.addEventListener(
    "resize",
    () => {
      applyPos(currentPos);
    },
    true
  );

  refs.launcherFab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: currentPos.left,
      startTop: currentPos.top,
      moved: false
    };
    try {
      refs.launcherFab.setPointerCapture(e.pointerId);
    } catch {
      void 0;
    }
  });

  refs.launcherFab.addEventListener("pointermove", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    applyPos({ left: drag.startLeft + dx, top: drag.startTop + dy });
  });

  const endDrag = (e, suppressClick) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    // pointermove 可能被页面卡顿合并；在松手时再根据最终坐标判定一次。
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4;
    if (moved) {
      applyPos({
        left: drag.startLeft + e.clientX - drag.startX,
        top: drag.startTop + e.clientY - drag.startY
      });
    }
    drag = null;
    if (moved) {
      suppressNextClick = suppressClick;
      chrome.storage.sync.set({ launcherPos: currentPos }).catch(() => void 0);
    }
  };
  refs.launcherFab.addEventListener("pointerup", (e) => endDrag(e, true));
  refs.launcherFab.addEventListener("pointercancel", (e) => endDrag(e, false));

  refs.launcherFab.addEventListener("click", (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    setOpen(!STATE.open);
  });
  document.documentElement.appendChild(refs.launcherFab);

  // 数据统计气泡
  refs.launcherBadge = el("div", {
    id: "web2ai_launcher_badge",
    style: {
      position: "fixed",
      display: "none",
      left: `${defaultLeft() + size}px`,
      top: `${defaultTop()}px`,
      padding: "7px 14px",
      borderRadius: "999px",
      background: "rgba(59,130,246,0.95)",
      color: "#fff",
      fontSize: "12px",
      fontWeight: "700",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
      opacity: "0",
      transform: "translate(-100%, -100%) scale(0.9)",
      transition: "opacity 0.25s ease, transform 0.25s ease"
    }
  });
  document.documentElement.appendChild(refs.launcherBadge);
}

function initOverlay() {
  ensureTableRowFab();

  if (IS_TOP_FRAME) {
    ensureHotkeys();
    ensureOverlay();
    ensureLauncherFab();
  }
}

function downloadTableGroup(group, format, index) {
  const enabledGroup = {
    ...group,
    header: group.header?.enabled !== false ? group.header : null,
    rows: group.rows.filter((row) => row.enabled !== false)
  };
  const isCsv = format === "csv";
  const content = isCsv
    ? `\uFEFF${tableGroupToCsv(enabledGroup, COL_SEPARATOR)}`
    : tableGroupToMarkdown(enabledGroup, COL_SEPARATOR);
  const blob = new Blob([content], { type: isCsv ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `web2ai-table-${index + 1}.${isCsv ? "csv" : "md"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export {
  ensureOverlay,
  ensureHotkeys,
  ensureLauncherFab,
  render,
  scheduleRender,
  setOpen,
  setMaximized,
  toggleMaximized,
  applyDraftToInputIfPresent,
  insertIntoDraft,
  clearDraftInput,
  sliceRecentRounds,
  sendText,
  onSend,
  initOverlay
};
