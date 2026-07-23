/**
 * @fileoverview 上下文管理核心。
 *
 * 职责：
 * - 添加/删除/清空上下文片段
 * - 表格分组管理（优先按 headerRef，随后按 tableId，最后兼容旧数据）
 * - 构建发送给 AI 的上下文块（含列名标注）
 * - 页面快照生成和页面分析功能
 * - 兼容旧版字符阈值确认弹窗（当前发送主路径使用 token-budget.js）
 *
 * 关键概念：
 * - `STATE.contexts`：所有上下文片段的扁平列表
 * - `STATE.tableGroups`：由扁平 contexts 派生的表格视图，不单独持久化
 * - `ref`：每个上下文的唯一引用标记（当前格式 `CTX_<uid>`，兼容旧 `CTX<num>`）
 * - `tableId`：兼容字段名，值为页面生命周期内的组件实例 tableKey
 * - `headerRef`：数据行与实际表头的显式关联
 */

import { DEBUG, IS_TOP_FRAME, STATE, COL_SEPARATOR, CONTEXT_CHAR_LIMIT, CONTEXT_WARN_LIMIT, Z_INDEX, uid, normalizeText, truncateText, compactOneLine, refs } from './state.js';
import { el, getCssSelector, isVisibleElement, getElementLabel } from './dom.js';
import { showToast } from './toast.js';
import { BUSINESS_TEXT_EXCLUDE_SELECTOR, DERIVED_COLUMN_SELECTOR, getBusinessRowText, getRowCells, hasHeaderCells } from './table-row-dom.js';
import { buildContextBlockFromContexts, getTableContextIdentity, groupTableContexts } from './context-model.js';
import { createContextRef } from './context-ref.js';

const contextDependencies = {
  highlightRow: () => void 0,
  removePinnedRowOverlay: () => void 0,
  syncRowCheckboxState: () => void 0,
  updateBatchBar: () => void 0,
  clearAllTableSelectionState: () => void 0,
  render: () => void 0,
  clearDraftInput: () => void 0
};

/** 注入表格和 Overlay 动作，避免三个有状态模块形成循环依赖。 */
function initContextDependencies(actions = {}) {
  for (const name of Object.keys(contextDependencies)) {
    if (typeof actions[name] === "function") contextDependencies[name] = actions[name];
  }
}

// 安全版 chrome.runtime.sendMessage — 扩展上下文失效时静默忽略
function safeSend(msg) {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => void 0);
  } catch {
    return Promise.resolve();
  }
}

function addContextSnippet(snippet) {
  const t0 = performance.now();
  const text = normalizeText(snippet?.text);
  DEBUG && console.log(`[web2ai] addContextSnippet kind=${snippet?.kind} text="${text?.slice(0, 60)}" IS_TOP_FRAME=${IS_TOP_FRAME} tableGroups.length=${STATE.tableGroups.length}`);
  if (!text && !snippet?.imageData) {
    showToast("没有可添加的内容");
    return;
  }
  const kind = snippet.kind || "snippet";
  let anchorSelector = snippet.anchorSelector || "";
  let quote = snippet.quote || "";
  let lineInfo = snippet.lineInfo || null;
  if ((kind === "table-row" || kind === "table-header") && (!anchorSelector || !quote)) {
    const rowEl = snippet.rowEl || snippet.tr;
    anchorSelector = anchorSelector || getCssSelector(rowEl);
    quote = quote || normalizeText(text).slice(0, 80);
  }
  const ref = snippet.ref || createContextRef();
  const item = {
    id: uid(),
    ref,
    kind,
    text: truncateText(text, 8000),
    // 截图仅保存在当前页面内存中，不进入 storage；发送时转换为多模态 image_url。
    imageData: kind === "screenshot" ? String(snippet.imageData || "") : "",
    imageMimeType: kind === "screenshot" ? String(snippet.imageMimeType || "image/jpeg") : "",
    url: snippet.url || location.href,
    title: snippet.title || document.title,
    createdAt: Date.now(),
    anchorSelector,
    quote,
    lineInfo,
    silent: snippet.silent,
    cellCount: snippet.cellCount || 0,
    // tableId 保存运行时组件 tableKey；固定表头/表体拆分时由 headerRef 跨组件关联。
    tableId: snippet.tableId || "",
    headerRef: snippet.headerRef || "",
    pageIndex: Number.isFinite(snippet.pageIndex) ? snippet.pageIndex : null,
    rowKey: snippet.rowKey || ""
  };
  if (!IS_TOP_FRAME) {
    safeSend({
      type: "FORWARD_TO_TOP",
      payload: { message: { type: "ADD_CONTEXT_SNIPPET", snippet: item } }
    });
    return;
  }

  // DOM/UI 层已经去重，这里再做最终幂等保护，避免单选与批量事件紧邻触发时重复写入。
  const identity = getTableContextIdentity(item);
  if (identity && STATE.contexts.some((context) => getTableContextIdentity(context) === identity)) {
    return;
  }

  STATE.contexts.unshift(item);
  STATE.onboarding = null;
  STATE.tableGroups = groupTableContexts(STATE.contexts);
  const elapsed = performance.now() - t0;
  if (elapsed > 5) DEBUG && console.log(`[web2ai] addContextSnippet done: ${elapsed.toFixed(1)}ms silent=${snippet.silent} kind=${snippet?.kind}`);
  if (!snippet.silent) {
    DEBUG && console.log(`[web2ai] addContextSnippet calling render() (silent=${snippet.silent})`);
    contextDependencies.render();
  } else {
    DEBUG && console.log(`[web2ai] addContextSnippet skip render() (silent=${snippet.silent})`);
  }
}

function removeContextByRef(ref, opts = {}) {
  if (!ref) return;
  const rowEl = refs.refToRowEl.get(ref);
  if (rowEl) {
    contextDependencies.removePinnedRowOverlay(rowEl);
    contextDependencies.highlightRow(rowEl, false);
    refs.selectedRowRef.delete(rowEl);
    refs.refToRowEl.delete(ref);
  }
  contextDependencies.syncRowCheckboxState(false);
  contextDependencies.updateBatchBar();
  if (!IS_TOP_FRAME) {
    safeSend({
      type: "FORWARD_TO_TOP",
      payload: { message: { type: "REMOVE_CONTEXT_BY_REF", ref } }
    });
    return;
  }
  const ctx = STATE.contexts.find((c) => c.ref === ref);
  if (!ctx) return;
  removeContext(ctx.id, opts);
}

function removeContext(id, opts = {}) {
  try {
    const ctx = STATE.contexts.find((c) => c.id === id);
    DEBUG && console.log(`[web2ai] removeContext start: id=${id} kind=${ctx?.kind} ref=${ctx?.ref}`);
    DEBUG && console.log(`[web2ai] removeContext state before: contexts=${STATE.contexts.length} tableGroups=${STATE.tableGroups.length}`, STATE.tableGroups.map(g => `[${g.header?.ref||"-"} rows=${g.rows.length}]`).join(", "));
    DEBUG && console.log(`[web2ai] removeContext refs: selectedRowRef=${refs.selectedRowRef.size} refToRowEl=${refs.refToRowEl.size} refToCheckbox=${refs.refToCheckbox.size} batchAnchorRow=${!!refs.batchAnchorRow}`);
    if (ctx?.ref) {
      DEBUG && console.log(`[web2ai] removeContext ref=${ctx.ref} refToCheckbox.has=${refs.refToCheckbox.has(ctx.ref)} refToRowEl.has=${refs.refToRowEl.has(ctx.ref)}`);
      safeSend({
        type: "BROADCAST_TO_TAB",
        payload: { message: { type: "UNSELECT_ROW_BY_REF", ref: ctx.ref } }
      });
      contextDependencies.syncRowCheckboxState(false);
      let rowEl = refs.refToRowEl.get(ctx.ref);
      if (!rowEl && ctx.anchorSelector) {
        try { rowEl = document.querySelector(ctx.anchorSelector); } catch {}
      }
      DEBUG && console.log(`[web2ai] removeContext header rowEl=`, rowEl?.tagName, rowEl?.isConnected);
      if (rowEl) {
        contextDependencies.removePinnedRowOverlay(rowEl);
        contextDependencies.highlightRow(rowEl, false);
        refs.selectedRowRef.delete(rowEl);
        refs.refToRowEl.delete(ctx.ref);
      }
      refs.refToCheckbox.delete(ctx.ref);
      const rowKey = refs.refToRowKey.get(ctx.ref);
      if (rowKey) refs.rowKeyToRef.delete(rowKey);
      refs.refToRowKey.delete(ctx.ref);
      const virtualPosition = refs.refToVirtualRowPosition.get(ctx.ref);
      if (virtualPosition) refs.virtualRowPositionToRef.delete(virtualPosition);
      refs.refToVirtualRowPosition.delete(ctx.ref);
      const renderedIdentity = refs.refToRenderedRowIdentity.get(ctx.ref);
      if (renderedIdentity && refs.renderedRowIdentityToRef.get(renderedIdentity) === ctx.ref) {
        refs.renderedRowIdentityToRef.delete(renderedIdentity);
      }
      refs.refToRenderedRowIdentity.delete(ctx.ref);
      refs.refToRowMeta.delete(ctx.ref);
    }
    STATE.contexts = STATE.contexts.filter((c) => c.id !== id);
    STATE.onboarding = null;
    if (ctx?.ref) {
      // 如果是表头，广播所有下属行的引用给各 frame 自行清理
      if (ctx.kind === "table-header") {
        DEBUG && console.log(`[web2ai] removeContext HEADER detected, broadcasting row refs for cleanup`);
        const group = STATE.tableGroups.find((g) => g.header?.ref === ctx.ref);
        DEBUG && console.log(`[web2ai] removeContext group found:`, group ? `rows=${group.rows.length}` : "NONE");
        if (group) {
          const rowRefs = group.rows.map((r) => r.ref).filter(Boolean);
          DEBUG && console.log(`[web2ai] removeContext broadcasting cleanup for refs:`, rowRefs);
          // 从 STATE.contexts 移除所有行
          for (const row of group.rows) {
            STATE.contexts = STATE.contexts.filter((c) => c.id !== row.id);
          }
          // 广播：让各 frame 通过各自的 refToRowEl 找行并清理
          safeSend({
            type: "BROADCAST_TO_TAB",
            payload: { message: { type: "UNSELECT_ROWS_BY_REFS", refs: rowRefs } }
          });
        }
        refs.batchAnchorRow = null;
        refs.batchContainer = null;
      }
      removeFromTableGroups(ctx.ref);
    }
    DEBUG && console.log(`[web2ai] removeContext state after: contexts=${STATE.contexts.length} tableGroups=${STATE.tableGroups.length}`, STATE.tableGroups.map(g => `[${g.header?.ref||"-"} rows=${g.rows.length}]`).join(", "));
    contextDependencies.updateBatchBar();
    if (!opts?.silent) contextDependencies.render();
  } catch (e) {
    console.warn("[web2ai] removeContext error:", e);
  }
}

function removeFromTableGroups(ref) {
  for (let gi = 0; gi < STATE.tableGroups.length; gi++) {
    const g = STATE.tableGroups[gi];
    if (g.header?.ref === ref) {
      STATE.tableGroups.splice(gi, 1);
      return;
    }
    const idx = g.rows.findIndex(r => r.ref === ref);
    if (idx !== -1) {
      g.rows.splice(idx, 1);
      if (g.rows.length === 0) {
        // 所有行被移除后，也清理表头的 context 和页面上的 check
        if (g.header?.ref) {
          STATE.contexts = STATE.contexts.filter(c => c.ref !== g.header.ref);
          const headerRowEl = refs.refToRowEl.get(g.header.ref);
          if (headerRowEl) {
            contextDependencies.removePinnedRowOverlay(headerRowEl);
            contextDependencies.highlightRow(headerRowEl, false);
            refs.selectedRowRef.delete(headerRowEl);
          }
          refs.refToRowEl.delete(g.header.ref);
          refs.refToCheckbox.delete(g.header.ref);
          // 广播到所有 frame 清理表头的视觉状态（处理 iframe 场景，表头 DOM 不在 top frame）
          safeSend({
            type: "BROADCAST_TO_TAB",
            payload: { message: { type: "UNSELECT_ROW_BY_REF", ref: g.header.ref } }
          });
        }
        STATE.tableGroups.splice(gi, 1);
      }
      return;
    }
  }
}

function clearContext() {
  DEBUG && console.log(`[web2ai] clearContext refToCheckbox size=${refs.refToCheckbox.size} refToRowEl size=${refs.refToRowEl.size} pinnedRowOverlays size=${refs.pinnedRowOverlays.size}`);
  STATE.contexts = [];
  STATE.tableGroups = [];
  STATE.onboarding = null;
  // 先同步清理当前 frame，再广播到 iframe；避免等待异步消息期间被滚动恢复逻辑重新绑定。
  contextDependencies.clearAllTableSelectionState();
  // 广播到其他 frames（iframe 等），由各 frame 自行清理 refToRowEl/refToCheckbox
  safeSend({ type: "BROADCAST_TO_TAB", payload: { message: { type: "CLEAR_ROW_UI" } } });
  contextDependencies.render();
}

function clearChat() {
  STATE.messages = [];
  contextDependencies.render();
}

function clearAll() {
  if (STATE.pending) return;
  clearContext();
  clearChat();
  contextDependencies.clearDraftInput();
}

function buildContextBlock(contexts, compact = false) {
  return buildContextBlockFromContexts(contexts, { compact, columnSeparator: COL_SEPARATOR });
}

function getContextTotalChars(contexts) {
  return contexts.reduce((sum, c) => sum + (c.text?.length || 0), 0);
}

function confirmContextOverflow(contexts, limit) {
  return new Promise((resolve) => {
    const total = getContextTotalChars(contexts);
    const ratio = Math.min(100, Math.round((limit / total) * 100));
    const dialog = el("div", {
      style: {
        position: "fixed",
        inset: "0",
        zIndex: Z_INDEX,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
        fontFamily: "system-ui, -apple-system, sans-serif"
      }
    });
    const box = el("div", {
      style: {
        background: "#fff",
        borderRadius: "16px",
        padding: "24px",
        maxWidth: "420px",
        width: "90%",
        boxShadow: "0 12px 36px rgba(0,0,0,0.25)",
        fontSize: "13px",
        color: "#111827",
        lineHeight: "1.5"
      }
    });
    box.appendChild(el("div", { style: { fontWeight: 650, fontSize: "15px", marginBottom: "12px" } }, ["上下文较大"]));
    box.appendChild(el("div", { style: { marginBottom: "16px", color: "#6b7280" } }, [
      `当前上下文共 ${total.toLocaleString()} 字符，超过建议上限 ${limit.toLocaleString()} 字符。`
    ]));
    box.appendChild(el("div", { style: { marginBottom: "16px", color: "#6b7280" } }, [
      `如提交全部上下文，约消耗 ${ratio < 100 ? "较多" : "大量"} token。建议仅提交部分（约 ${ratio}%）。`
    ]));

    const btnRow = el("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } });

    const cancelBtn = el("button", {
      class: "btn",
      style: { fontSize: "12px" },
      onClick: () => {
        dialog.remove();
        resolve(null);
      }
    }, ["取消发送"]);
    btnRow.appendChild(cancelBtn);

    const partialBtn = el("button", {
      class: "btn",
      style: { fontSize: "12px" },
      onClick: () => {
        dialog.remove();
        const partial = [];
        let budget = limit;
        for (const c of contexts) {
          if (budget <= 0) break;
          const take = Math.min(c.text?.length || 0, budget);
          partial.push({ ...c, text: c.text.slice(0, take) });
          budget -= take;
        }
        resolve(partial);
      }
    }, [`提交部分（约 ${ratio}%）`]);
    btnRow.appendChild(partialBtn);

    const allBtn = el("button", {
      class: "btn primary",
      style: { fontSize: "12px" },
      onClick: () => {
        dialog.remove();
        resolve(contexts);
      }
    }, ["全部提交"]);
    btnRow.appendChild(allBtn);

    box.appendChild(btnRow);
    dialog.appendChild(box);
    document.documentElement.appendChild(dialog);
  });
}

function extractTableHeadersFromContexts(contexts) {
  const groups = groupTableContexts(contexts);
  if (groups.length > 0) {
    const result = [];
    for (const g of groups) {
      if (g.header?.text) {
        const cols = g.header.text.split(COL_SEPARATOR).filter(Boolean);
        if (cols.length) result.push(cols);
      }
    }
    return result;
  }
  const headerCtx = contexts.find(c => c.kind === "table-header");
  if (!headerCtx || !headerCtx.text) return [];
  const cols = headerCtx.text.split(COL_SEPARATOR).filter(Boolean);
  return cols.length ? [cols] : [];
}

function getTableGroupCount() {
  return STATE.tableGroups.length || 0;
}

function getHeaderlessGroupCount() {
  return STATE.tableGroups.filter(g => !g.header).length;
}

function buildHeaderGuidePrompt(headers, sampleRowsText, headerlessSampleRows) {
  const totalGroups = getTableGroupCount();
  const headerlessCount = getHeaderlessGroupCount();
  let tablesSection = "";
  if (headers.length > 0) {
    const parts = [];
    for (let ti = 0; ti < headers.length; ti++) {
      const cols = headers[ti];
      const colLines = cols.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
      let tableBlock = `表格 ${ti + 1} 的列：\n${colLines}`;
      if (sampleRowsText && sampleRowsText[ti]) {
        tableBlock += `\n数据样例（第一行）：${sampleRowsText[ti]}`;
      }
      parts.push(tableBlock);
    }
    tablesSection = "\n" + parts.join("\n\n");
  }
  if (headerlessCount > 0) {
    tablesSection += `\n（另有 ${headerlessCount} 组数据没有列名，请根据实际数据内容进行分析。数据按 "|||" 分隔，[列1] [列2] 等为系统自动添加的列序号）`;
    if (headerlessSampleRows && headerlessSampleRows.length > 0) {
      for (let i = 0; i < headerlessSampleRows.length; i++) {
        tablesSection += `\n无列名数据 ${i + 1} 的前两行样例：${headerlessSampleRows[i]}`;
      }
    }
  }

  const totalDesc = totalGroups > 0 ? `${totalGroups} 组` : "数据";
  const hasNamedHeaders = headers.length > 0;

  const analysisHint = hasNamedHeaders
    ? "请根据以上数据的列名和数据样例"
    : "请根据以上数据的实际内容";

  return `用户选中了 ${totalDesc}数据，但还没有想好具体要问什么。以下是用户选中的数据：${tablesSection}

${analysisHint}，给用户提供 3-5 个可以直接点击使用的分析方向建议，每个建议用一句话描述，格式如：
- 📊 建议标题：具体分析内容说明

要求：
1. 每个建议必须具体、可执行，用户复制粘贴就能直接提问
2. 覆盖不同的分析角度（如概览、对比、异常、趋势等），并且要贴合实际数据的含义
3. 如果涉及多组数据，可以给出跨组联合分析的建议
4. 语气轻松友好，降低用户的使用门槛
5. 不要反问用户问题，而是直接给出可用的分析方向

在所有建议的最后，加一句引导：当然，你也可以直接输入你想问的问题，我来帮你分析。`;
}

/**
 * 从容器中提取表头列名（通用实现）。
 * 支持：thead th、role=columnheader、scope=col、div-based 表格等
 */
function extractTableHeaders(container) {
  // 1. 直接检查标准表头
  const directHeaders = container.querySelectorAll(
    'thead th, thead td, [role="columnheader"], [role="rowheader"], [scope="col"]'
  );
  if (directHeaders.length) {
    const cols = Array.from(directHeaders)
      .map((th) => normalizeText(th.innerText || th.textContent || ""))
      .filter(Boolean);
    if (cols.length) return cols;
  }

  // 2. 向上追溯找兄弟中的表头
  let ancestor = container.parentElement;
  let level = 0;
  while (ancestor) {
    // 在祖先的子元素中找包含 th/columnheader 的兄弟
    if (level % 2 === 0) {
      const siblings = Array.from(ancestor.children).filter(
        c => c !== container && !c.contains(container)
      );
      for (const sib of siblings) {
        if (!isVisibleElement(sib)) continue;
        const cells = sib.querySelectorAll(
          'th, [role="columnheader"], [role="rowheader"], [scope="col"]'
        );
        if (cells.length) {
          const cols = Array.from(cells)
            .map((cell) => normalizeText(cell.innerText || cell.textContent || ""))
            .filter(Boolean);
          if (cols.length > 1) return cols;
        }
      }
    }
    ancestor = ancestor.parentElement;
    level++;
  }

  return [];
}

function extractTableRowText(rowEl) {
  if (!rowEl) return "";
  return normalizeText(getBusinessRowText(rowEl, {
    separator: COL_SEPARATOR,
    emptyPlaceholder: "-"
  }));
}

function extractBusinessTextFromElement(element) {
  if (!element) return "";
  const clone = element.cloneNode?.(true);
  if (!clone) return normalizeText(element.textContent || "");
  clone.querySelectorAll?.(BUSINESS_TEXT_EXCLUDE_SELECTOR).forEach((node) => node.remove());
  return normalizeText(clone.textContent || "");
}

function extractPageText() {
  const candidates = [
    document.querySelector("article"),
    document.querySelector("main"),
    document.querySelector('[role="main"]'),
    document.body
  ].filter(Boolean);

  const pick = candidates
    .map((node) => ({ node, len: extractBusinessTextFromElement(node).length }))
    .sort((a, b) => b.len - a.len)[0]?.node;

  const text = extractBusinessTextFromElement(pick);
  const header = `${document.title}\n${location.href}\n\n`;
  return truncateText(header + text, 12000);
}

function buildPageUsageSnapshot() {
  const lines = [];
  lines.push("PAGE_SNAPSHOT v1");
  lines.push(`Title: ${compactOneLine(document.title)}`);
  lines.push(`URL: ${location.href}`);

  const headings = Array.from(
    document.querySelectorAll("h1,h2,h3,[role='heading']")
  )
    .filter(isVisibleElement)
    .map((h) => compactOneLine(h.innerText || h.textContent || ""))
    .filter(Boolean)
    .slice(0, 18);
  if (headings.length) {
    lines.push("");
    lines.push("HEADINGS:");
    for (const t of headings) lines.push(`- ${t.slice(0, 120)}`);
  }

  const controls = Array.from(
    document.querySelectorAll(
      "button,a,[role='button'],[role='tab'],[role='menuitem'],input,select,textarea"
    )
  )
    .filter(isVisibleElement)
    .map((el) => {
      const tag = el.tagName.toLowerCase();
      const role = compactOneLine(el.getAttribute?.("role") || "");
      const type = compactOneLine(el.getAttribute?.("type") || "");
      const label = getElementLabel(el).slice(0, 80);
      const rect = el.getBoundingClientRect?.() || { top: 0, left: 0 };
      const disabled =
        el.disabled === true || el.getAttribute?.("aria-disabled") === "true" ? " disabled" : "";
      const kind = role ? `${tag}[role=${role}]` : tag;
      const t = `${kind}${type ? `[type=${type}]` : ""}${disabled}: ${label || "(no text)"}`;
      return { t, top: rect.top || 0, left: rect.left || 0 };
    })
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .map((x) => x.t);

  const uniqControls = [];
  const seen = new Set();
  for (const c of controls) {
    if (seen.has(c)) continue;
    seen.add(c);
    uniqControls.push(c);
    if (uniqControls.length >= 26) break;
  }
  if (uniqControls.length) {
    lines.push("");
    lines.push("ACTIONS_AND_FIELDS:");
    for (const t of uniqControls) lines.push(`- ${t}`);
  }

  const tables = Array.from(document.querySelectorAll("table")).slice(0, 4);
  if (tables.length) {
    lines.push("");
    lines.push("TABLES:");
    tables.forEach((table, i) => {
      const headerCells = Array.from(table.querySelectorAll(
        "thead th, thead td, [scope='col'], [role='columnheader']"
      ))
        .filter((cell) => !cell.matches?.(DERIVED_COLUMN_SELECTOR))
        .map((th) => compactOneLine(th.innerText || th.textContent || ""))
        .filter(Boolean);
      const headerLine = headerCells.length ? headerCells.join(" | ") : "(no headers found)";
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(tr => {
        const cells = getRowCells(tr);
        return cells.length > 0 && !hasHeaderCells(tr);
      }).slice(0, 3);
      const samples = rows
        .map((tr) => compactOneLine(extractTableRowText(tr)))
        .filter(Boolean)
        .map((t) => t.slice(0, 220));
      lines.push(`- Table ${i + 1}: columns: ${headerLine.slice(0, 320)}`);
      if (samples.length) {
        for (const s of samples) lines.push(`  - row: ${s}`);
      }
    });
  }

  const mainText = extractPageText();
  if (mainText) {
    lines.push("");
    lines.push("PAGE_TEXT_SNIPPET:");
    lines.push(mainText.slice(0, 1600));
  }

  return truncateText(lines.join("\n"), 8000);
}

async function analyzeCurrentPage() {
  if (!IS_TOP_FRAME) {
    showToast("请在顶层页面使用\u201C分析页面\u201D");
    return;
  }
  if (STATE.pending) return;
  const snapshot = buildPageUsageSnapshot();
  const ref = createContextRef();
  addContextSnippet({
    kind: "page-snapshot",
    text: snapshot,
    url: location.href,
    title: document.title,
    ref
  });
  const prompt =
    "请根据最新加入的页面快照，向我介绍这个页面的用途、主要功能区、常见操作路径，并重点说明如果页面里有表格，每一列应该怎么看（基于列名/内容推断，给出可验证的理解）。最后给出3条值得深入分析的问题建议。";
  const { sendText } = await import('./overlay.js');
  await sendText(prompt);
}

export {
  initContextDependencies,
  addContextSnippet,
  removeContextByRef,
  removeContext,
  removeFromTableGroups,
  clearContext,
  clearChat,
  clearAll,
  buildContextBlock,
  getContextTotalChars,
  confirmContextOverflow,
  extractTableHeadersFromContexts,
  buildHeaderGuidePrompt,
  extractTableHeaders,
  extractTableRowText,
  extractPageText,
  buildPageUsageSnapshot,
  analyzeCurrentPage
};
