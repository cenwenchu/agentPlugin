/**
 * @fileoverview 技能第一轮：单个数据源的选择、持久化与刷新后校验。
 * 同时提供自然语言分析方法、当前已渲染数据读取与测试结果保存能力。
 */

import { IS_TOP_FRAME, STATE, compactOneLine, refs, uid } from "./state.js";
import { getCssSelector } from "./dom.js";
import { showToast } from "./toast.js";
import { showConfirmDialog, showPromptDialog } from "./dialog.js";
import { findHeaderRowAbove, getRowCells, getStableTableRoot, isHeaderRow } from "./table.js";

const STORAGE_KEY = "web2aiSkills";
const PAGE_NAMES_STORAGE_KEY = "web2aiSkillPageNames";
const TABLE_SELECTOR = [
  "table", '[role="table"]', '[role="grid"]', '[role="treegrid"]',
  ".art-table", ".ant-table-wrapper", ".arco-table"
].join(",");

let renderCallback = () => void 0;
let activePickSession = "";
let cancelActivePick = null;
let observedPageKey = "";
let pageWatchTimer = null;

function emptyAnalysisMethod() {
  return { description: "" };
}

function normalizeAnalysisMethod(value) {
  if (typeof value === "string") return { description: value };
  const source = value && typeof value === "object" ? value : {};
  if (String(source.description || "").trim()) return { description: String(source.description) };
  // 将第二轮早期版本的五段式配置无损合并，旧技能打开后也只需编辑一个输入框。
  const legacySections = [
    ["分析目标", source.objective],
    ["关注重点", source.focus],
    ["判断规则", source.rules],
    ["输出要求", source.outputFormat],
    ["补充说明", source.notes]
  ].filter(([, content]) => String(content || "").trim());
  return { description: legacySections.map(([title, content]) => `${title}：${String(content).trim()}`).join("\n") };
}

function buildAnalysisPrompt(method) {
  return normalizeAnalysisMethod(method).description.trim();
}

function getAnalysisGuidance(method, headers = []) {
  const text = buildAnalysisPrompt(method);
  if (!text) return ["先用自己的话描述希望 AI 分析什么，例如：找出可能延迟发货的订单，并说明原因和处理建议。"];
  const guidance = [];
  if (text.length < 24) guidance.push("可以再具体一些：什么情况值得关注？");
  if (!/(超过|低于|高于|等于|异常|风险|条件|规则|标准|如果|当|未|没有|天|小时|%|比例)/i.test(text)) {
    guidance.push("可以补充判断依据，例如时间、金额、状态或业务规则。");
  }
  if (!/(输出|列出|返回|展示|按照|分组|排序|表格|清单|总结|建议|原因|结论)/i.test(text)) {
    guidance.push("可以补充期望的结果形式，例如列出对象、原因、风险等级和建议。");
  }
  const normalizedHeaders = (headers || []).map((header) => String(header).trim()).filter((header) => header.length > 1);
  if (normalizedHeaders.length && !normalizedHeaders.some((header) => text.includes(header))) {
    guidance.push(`可以引用需要重点分析的数据源字段，例如：${normalizedHeaders.slice(0, 4).join("、")}。`);
  }
  return guidance.length ? guidance.slice(0, 3) : ["描述已经比较完整，可以保存并进入后续测试。"];
}

function pageKey(url = location.href) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "");
  }
}

function normalizeHeader(value) {
  return compactOneLine(value).toLowerCase();
}

function tableCandidates() {
  const candidates = Array.from(document.querySelectorAll(TABLE_SELECTOR));
  return candidates.filter((candidate, index) => !candidates.some((parent, parentIndex) => (
    parentIndex !== index && parent.contains(candidate) && parent.matches(TABLE_SELECTOR)
  )));
}

function resolveTableFromTarget(target) {
  if (!(target instanceof Element)) return null;
  const row = target.closest("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const componentRoot = row ? getStableTableRoot(row) : null;
  if (componentRoot) return componentRoot;
  const matched = target.closest(TABLE_SELECTOR);
  if (!matched) return null;
  return tableCandidates().find((candidate) => candidate === matched || candidate.contains(matched)) || matched;
}

function cellTexts(cells) {
  return cells
    .map((cell) => compactOneLine(cell.innerText || cell.textContent || ""))
    .filter(Boolean)
    .slice(0, 80);
}

function alignedRowCellTexts(cells, expectedColumnCount) {
  const values = [];
  for (const cell of cells.slice(0, 80)) {
    values.push(compactOneLine(cell.innerText || cell.textContent || ""));
    // 合并单元格只占一个 DOM 节点，但后续单元格仍需保持原列位置。
    const span = Math.max(1, Number(cell.colSpan || cell.getAttribute?.("colspan")) || 1);
    for (let index = 1; index < span; index++) values.push("");
  }
  if (!expectedColumnCount) return values;
  // 很多数据组件在最左侧额外放置无标题的选择列。表头采集会忽略该空标题，
  // 因此只移除超出字段数的首尾空辅助列；业务列中间的空值必须原位保留。
  while (values.length > expectedColumnCount && values[0] === "") values.shift();
  while (values.length > expectedColumnCount && values.at(-1) === "") values.pop();
  if (values.length > expectedColumnCount) values.length = expectedColumnCount;
  while (values.length < expectedColumnCount) values.push("");
  return values;
}

function clickedHeaderCells(target) {
  if (!(target instanceof Element)) return [];
  const row = target.closest(
    "thead tr, [role='row'], .art-table-header-row, .ant-table-row, .arco-table-tr, " +
    "[class*='table-header'][class*='row'], [class*='table-head'][class*='row']"
  );
  if (!row) return [];
  const looksLikeHeader = isHeaderRow(row) || /(?:^|[-_\s])(header|thead|head)(?:[-_\s]|$)/i.test(row.className || "") || Boolean(row.closest("thead, [class*='table-header'], [class*='table-head']"));
  if (!looksLikeHeader) return [];
  return getRowCells(row);
}

function extractHeaders(table, preferredTarget = null) {
  if (!table) return [];
  // 优先读取完整表头区域。多级表头中，用户可能点击第一行的合并标题，
  // 但第二行仍包含实际细分列；绑定与刷新必须采用相同的完整集合。
  let cells = Array.from(table.querySelectorAll(
    "thead th, [role='columnheader'], th[scope='col'], " +
    ".art-table-header-cell, .ant-table-thead th, .arco-table-th, " +
    "[class*='table-header'] [class*='cell'], [class*='table-head'] [class*='cell']"
  ));
  // 非标准 div 表格无法标识完整表头区域时，再使用用户实际点击行兜底。
  if (!cells.length) cells = clickedHeaderCells(preferredTarget);
  // 复用 Chat 的表头关联算法，兼容固定表头与表体拆成兄弟 table 的组件。
  if (!cells.length) {
    const rows = Array.from(table.querySelectorAll("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"));
    const dataRow = rows.find((row) => !isHeaderRow(row) && getRowCells(row).length);
    const headerRow = dataRow ? findHeaderRowAbove(dataRow) : rows.find(isHeaderRow);
    if (headerRow) cells = getRowCells(headerRow);
  }
  if (!cells.length) {
    const firstRow = table.querySelector("tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
    cells = firstRow ? Array.from(firstRow.querySelectorAll("th, td, [role='cell'], [role='gridcell'], .art-table-cell, .ant-table-cell, .arco-table-td")) : [];
  }
  return cellTexts(cells);
}

function describeTable(table, preferredTarget = null) {
  const candidates = tableCandidates();
  const headers = extractHeaders(table, preferredTarget);
  console.info("[web2ai.skill] selected table", {
    frame: IS_TOP_FRAME ? "top" : "child",
    root: `${table.tagName.toLowerCase()}${table.id ? `#${table.id}` : ""}.${String(table.className || "").split(/\s+/).slice(0, 3).join(".")}`,
    clicked: preferredTarget ? `${preferredTarget.tagName.toLowerCase()}.${String(preferredTarget.className || "").split(/\s+/).slice(0, 3).join(".")}` : "none",
    headerCount: headers.length,
    headers: headers.slice(0, 12)
  });
  return {
    selector: getCssSelector(table),
    tableIndex: Math.max(0, candidates.indexOf(table)),
    headers,
    headerFingerprint: headers.map(normalizeHeader).join("|"),
    preview: headers.join("、") || "未识别到数据源字段",
    frameUrl: pageKey(location.href),
    pageTitle: document.title,
    capturedAt: Date.now()
  };
}

function headerSimilarity(expected, actual) {
  const left = new Set((expected || []).map(normalizeHeader).filter(Boolean));
  const right = new Set((actual || []).map(normalizeHeader).filter(Boolean));
  // 旧数据源可能由早期版本保存且没有表头指纹。只要表格仍能定位，
  // 不应误报“数据源已变化”；重新绑定后会补齐新指纹。
  if (!left.size) return 1;
  if (!right.size) return 0;
  let overlap = 0;
  for (const header of left) if (right.has(header)) overlap++;
  // 数据源身份关注“绑定时的列是否仍存在”。页面新增派生列/费用明细列不会
  // 破坏已有分析方法，因此不应降低可用性；删除或重命名原列才降低覆盖率。
  return overlap / left.size;
}

function resolveStoredSource(source) {
  const candidates = tableCandidates();
  let selectorTable = null;
  let matchMethod = "none";
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  // 通用 DOM 路径在不同 frame 中可能恰好命中普通 div。只有能够归一化到
  // 当前 frame 的真实表格组件根节点时才接受，否则继续走序号/表头兜底。
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const ranked = candidates.map((table) => ({
    table,
    score: headerSimilarity(source?.headers || [], extractHeaders(table)),
    priority: table === selectorTable ? 2 : table === indexedTable ? 1 : 0,
    method: table === selectorTable ? "selector" : table === indexedTable ? "tableIndex" : "headerSimilarity"
  })).sort((a, b) => (b.score - a.score) || (b.priority - a.priority));
  const selectedMatch = source?.headers?.length
    ? ranked[0]
    : ranked.find((item) => item.table === selectorTable) || ranked.find((item) => item.table === indexedTable);
  const selected = selectedMatch?.table || null;
  matchMethod = selectedMatch?.method || "none";
  if (!selected) return { found: false, candidateCount: candidates.length, frameUrl: pageKey(location.href) };
  const headers = extractHeaders(selected);
  const similarity = headerSimilarity(source?.headers || [], headers);
  const diagnostic = {
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    selector: source?.selector || "",
    storedTableIndex: source?.tableIndex,
    candidateCount: candidates.length,
    matchMethod,
    expectedHeaderCount: source?.headers?.length || 0,
    expectedHeaders: (source?.headers || []).slice(0, 80),
    actualHeaderCount: headers.length,
    actualHeaders: headers.slice(0, 80),
    similarity,
    status: similarity >= 0.8 ? "available" : "changed"
  };
  // 单行 JSON 便于从复杂业务页面控制台直接复制；仅包含表头，不输出业务数据行。
  console.info("[web2ai.skill] validated source", JSON.stringify(diagnostic));
  return {
    found: true,
    status: similarity >= 0.8 ? "available" : "changed",
    headers,
    similarity
  };
}

function extractStoredSourceData(source, limit = 200) {
  const candidates = tableCandidates();
  let selectorTable = null;
  try { selectorTable = source?.selector ? document.querySelector(source.selector) : null; } catch { selectorTable = null; }
  if (selectorTable) {
    const resolved = resolveTableFromTarget(selectorTable);
    selectorTable = resolved && candidates.includes(resolved) ? resolved : null;
  }
  const indexedTable = Number.isInteger(source?.tableIndex) ? candidates[source.tableIndex] || null : null;
  const ranked = candidates.map((table) => ({
    table,
    score: headerSimilarity(source?.headers || [], extractHeaders(table)),
    priority: table === selectorTable ? 2 : table === indexedTable ? 1 : 0
  })).sort((a, b) => (b.score - a.score) || (b.priority - a.priority));
  const selected = source?.headers?.length
    ? ranked[0]?.table
    : selectorTable || indexedTable;
  if (!selected) return { found: false, candidateCount: candidates.length };
  const headers = extractHeaders(selected);
  const allRows = Array.from(selected.querySelectorAll("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"))
    .filter((row) => !isHeaderRow(row))
    .map((row) => alignedRowCellTexts(getRowCells(row), headers.length))
    .filter((cells) => cells.length && cells.some(Boolean));
  const uniqueRows = [];
  const seen = new Set();
  for (const row of allRows) {
    const signature = row.join("\u241f");
    if (seen.has(signature)) continue;
    seen.add(signature);
    uniqueRows.push(row);
  }
  const rows = uniqueRows.slice(0, limit);
  return {
    found: true,
    status: headerSimilarity(source?.headers || [], headers) >= 0.8 ? "available" : "changed",
    headers,
    rows,
    rowCount: rows.length,
    totalRowCount: uniqueRows.length,
    truncated: uniqueRows.length > rows.length
  };
}

async function readSkills() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function writeSkills(skills) {
  await chrome.storage.local.set({ [STORAGE_KEY]: skills });
}

async function loadSkills() {
  if (!IS_TOP_FRAME) return;
  const [all, pageNamesData] = await Promise.all([
    readSkills(),
    chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY])
  ]);
  STATE.skillPageNames = pageNamesData[PAGE_NAMES_STORAGE_KEY] && typeof pageNamesData[PAGE_NAMES_STORAGE_KEY] === "object"
    ? pageNamesData[PAGE_NAMES_STORAGE_KEY]
    : {};
  STATE.skillCatalog = all;
  STATE.skills = all.filter((skill) => skill.pageKey === pageKey());
  STATE.skillSourceStatuses = Object.fromEntries(STATE.skills.map((skill) => [skill.id, { status: "checking" }]));
  renderCallback();
  await Promise.all(STATE.skills.map((skill) => validateSkillSource(skill)));
}

function createSkillDraft() {
  STATE.skillDraft = { id: "", name: "", sourceName: "", source: null, analysisMethod: emptyAnalysisMethod() };
  renderCallback();
}

function cancelSkillDraft() {
  STATE.skillDraft = null;
  renderCallback();
}

async function selectSkillTable() {
  if (!STATE.skillDraft) createSkillDraft();
  const sessionId = uid();
  STATE.skillPicking = true;
  STATE.skillPickSession = sessionId;
  STATE.open = false;
  renderCallback();
  await chrome.runtime.sendMessage({
    type: "BROADCAST_TO_TAB",
    payload: { message: { type: "START_SKILL_TABLE_PICK", sessionId } }
  });
}

async function startSkillCreation() {
  STATE.skillDraft = { id: "", name: "", sourceName: "", source: null, analysisMethod: emptyAnalysisMethod() };
  STATE.activePanelTab = "skills";
  await selectSkillTable();
}

function startSkillTablePickInFrame(sessionId) {
  if (!sessionId || activePickSession === sessionId) return;
  cancelActivePick?.();
  activePickSession = sessionId;
  let hovered = null;
  let hoveredTarget = null;
  let oldOutline = "";
  const hint = document.createElement("div");
  hint.dataset.web2aiUi = "skill-picker";
  hint.textContent = "移动到目标数据源并点击 · Esc 取消";
  Object.assign(hint.style, { position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", zIndex: "2147483647", padding: "9px 15px", borderRadius: "999px", background: "#111827", color: "#fff", font: "13px system-ui", pointerEvents: "none" });
  document.documentElement.appendChild(hint);
  const restore = () => { if (hovered) hovered.style.outline = oldOutline; };
  const cleanup = () => {
    restore(); hint.remove();
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (activePickSession === sessionId) activePickSession = "";
    cancelActivePick = null;
  };
  const sendResult = (payload) => {
    cleanup();
    chrome.runtime.sendMessage({ type: "SKILL_TABLE_PICK_RESULT", payload: { sessionId, ...payload } }).catch(() => void 0);
  };
  const onMove = (event) => {
    if (event.target === hint || event.target?.closest?.("#web2ai_overlay_host")) return;
    const table = resolveTableFromTarget(event.target);
    hoveredTarget = event.target instanceof Element ? event.target : null;
    if (table === hovered) return;
    restore(); hovered = table; oldOutline = table?.style.outline || "";
    if (table) table.style.outline = "3px solid #2563eb";
  };
  const onDown = (event) => {
    if (event.button !== 0 || !hovered) return;
    event.preventDefault(); event.stopImmediatePropagation();
    sendResult({ source: describeTable(hovered, event.target instanceof Element ? event.target : hoveredTarget) });
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); sendResult({ cancelled: true });
  };
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  cancelActivePick = cleanup;
}

function cancelSkillTablePickInFrame(sessionId) {
  if (sessionId && activePickSession && sessionId !== activePickSession) return;
  cancelActivePick?.();
}

function acceptSkillTablePickResult(payload) {
  if (!IS_TOP_FRAME || !STATE.skillPicking || payload?.sessionId !== STATE.skillPickSession) return;
  STATE.skillPicking = false;
  STATE.skillPickSession = "";
  STATE.open = true;
  STATE.activePanelTab = "skills";
  refs.suppressPanelCloseUntil = Date.now() + 1000;
  if (refs.panelCloseTimer) clearTimeout(refs.panelCloseTimer);
  refs.panelCloseTimer = null;
  if (payload.cancelled) {
    showToast("已取消选择数据源");
  } else if (payload.source) {
    STATE.skillDraft ||= { id: "", name: "", sourceName: "", source: null, analysisMethod: emptyAnalysisMethod() };
    STATE.skillDraft.source = { ...payload.source, frameId: payload.frameId || 0, frameUrl: payload.frameUrl || payload.source.frameUrl };
    if (!STATE.skillDraft.sourceName) STATE.skillDraft.sourceName = payload.source.pageTitle || "页面数据源";
  }
  renderCallback();
}

async function saveSkillDraft() {
  const draft = STATE.skillDraft;
  if (!draft?.source) return showToast("请先选择数据源");
  if (!String(draft.name).trim()) return showToast("请填写技能名称");
  if (!String(draft.sourceName).trim()) return showToast("请填写数据源名称");
  const all = await readSkills();
  const now = Date.now();
  const existing = all.find((skill) => skill.id === draft.id);
  const skill = {
    id: draft.id || uid(),
    version: 1,
    name: String(draft.name).trim(),
    pageKey: pageKey(),
    pageUrl: location.href,
    pageTitle: document.title,
    sourceName: String(draft.sourceName).trim(),
    source: draft.source,
    analysisMethod: normalizeAnalysisMethod(draft.analysisMethod),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const index = all.findIndex((item) => item.id === skill.id);
  if (index >= 0) all[index] = skill; else all.unshift(skill);
  await writeSkills(all);
  STATE.skillDraft = null;
  showToast(existing ? "技能已修改" : "技能已保存");
}

async function saveSkillAnalysisMethod(id, description) {
  const all = await readSkills();
  const skill = all.find((item) => item.id === id);
  if (!skill) throw new Error("技能不存在或已被删除");
  skill.analysisMethod = normalizeAnalysisMethod({ description });
  skill.updatedAt = Date.now();
  await writeSkills(all);
  await loadSkills();
  return skill;
}

function rebindSkill(id) {
  const skill = STATE.skills.find((item) => item.id === id);
  if (!skill) return;
  STATE.skillDraft = {
    id: skill.id,
    name: skill.name,
    sourceName: skill.sourceName,
    source: skill.source,
    analysisMethod: normalizeAnalysisMethod(skill.analysisMethod)
  };
  renderCallback();
}

async function deleteSkill(id) {
  const all = await readSkills();
  await writeSkills(all.filter((skill) => skill.id !== id));
}

async function deleteAllSkills() {
  if (!STATE.skillCatalog.length) return;
  const accepted = await showConfirmDialog(`确定删除全部 ${STATE.skillCatalog.length} 个技能吗？此操作无法撤销。`);
  if (!accepted) return;
  STATE.skillDraft = null;
  STATE.skills = [];
  STATE.skillCatalog = [];
  STATE.skillSourceStatuses = {};
  STATE.skillPageNames = {};
  await chrome.storage.local.set({
    [STORAGE_KEY]: [],
    [PAGE_NAMES_STORAGE_KEY]: {}
  });
  renderCallback();
  showToast("全部技能已删除");
}

async function switchToSkillPage(targetPageKey, targetUrl) {
  let response = await chrome.runtime.sendMessage({
    type: "SWITCH_TO_SKILL_PAGE",
    pageKey: targetPageKey,
    pageUrl: targetUrl
  }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  if (!response?.ok && response?.code === "PAGE_NOT_OPEN") {
    const accepted = await showConfirmDialog("该技能页面当前没有保持打开，是否在当前标签页打开？");
    if (!accepted) return;
    response = await chrome.runtime.sendMessage({
      type: "SWITCH_TO_SKILL_PAGE",
      pageKey: targetPageKey,
      pageUrl: targetUrl,
      allowNavigateCurrentTab: true
    }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  }
  if (!response?.ok) {
    showToast(response?.error || "无法打开技能页面", 3200);
  }
}

async function renameCurrentSkillPage() {
  const currentPageKey = pageKey();
  const fallbackName = STATE.skills[0]?.pageTitle || document.title || currentPageKey;
  const currentName = STATE.skillPageNames[currentPageKey] || fallbackName;
  const value = await showPromptDialog("修改当前页面名称", currentName);
  if (value === null) return;
  const nextName = compactOneLine(value);
  if (!nextName) {
    showToast("页面名称不能为空");
    return;
  }
  const names = { ...STATE.skillPageNames, [currentPageKey]: nextName };
  STATE.skillPageNames = names;
  await chrome.storage.local.set({ [PAGE_NAMES_STORAGE_KEY]: names });
  renderCallback();
  showToast("页面名称已修改");
}

async function validateSkillSource(skill) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "VALIDATE_SKILL_SOURCE", source: skill.source });
    STATE.skillSourceStatuses[skill.id] = response?.data || { status: "missing" };
    if (!response?.data?.found) {
      console.info("[web2ai.skill] validation result", JSON.stringify({
        skillId: skill.id,
        skillName: skill.name,
        status: response?.data?.status || "missing",
        sourceFrameUrl: pageKey(skill.source?.frameUrl || ""),
        probes: response?.data?.probes || []
      }));
    }
  } catch {
    STATE.skillSourceStatuses[skill.id] = { status: "missing" };
  }
  renderCallback();
}

function initSkills(onRender) {
  renderCallback = onRender || renderCallback;
  if (IS_TOP_FRAME && !pageWatchTimer) {
    observedPageKey = pageKey();
    // SPA 的 pushState/replaceState 不会重新执行 content script，也没有统一事件。
    // 轮询规范化后的页面键可同时覆盖 history API、前进后退和站点自定义路由。
    pageWatchTimer = setInterval(() => {
      const currentPageKey = pageKey();
      if (currentPageKey === observedPageKey) return;
      observedPageKey = currentPageKey;
      STATE.skillDraft = null;
      STATE.skillSourceStatuses = {};
      loadSkills().catch(() => void 0);
    }, 400);
  }
  loadSkills().catch(() => void 0);
}

const reloadSkills = loadSkills;
export {
  initSkills, reloadSkills, createSkillDraft, cancelSkillDraft, selectSkillTable, startSkillCreation,
  startSkillTablePickInFrame, cancelSkillTablePickInFrame, acceptSkillTablePickResult,
  saveSkillDraft, rebindSkill, deleteSkill, deleteAllSkills, resolveStoredSource, switchToSkillPage,
  renameCurrentSkillPage, buildAnalysisPrompt, getAnalysisGuidance,
  extractStoredSourceData, saveSkillAnalysisMethod
};
