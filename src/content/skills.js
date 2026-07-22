/**
 * @fileoverview 技能编辑、持久化、页面挂接及数据源能力兼容入口。
 *
 * 本模块运行在所有 frame：目标 frame 的定位和采集分别委托给
 * skill-source-dom.js 与 skill-collector.js；
 * top frame 负责技能目录、页面归属和状态汇总。持久化读取仍直接使用 storage，
 * 写入统一交给 background 串行 mutation；模型调用与全屏交互位于 overlay.js。
 */

import { DEBUG, IS_TOP_FRAME, STATE, compactOneLine, refs, uid } from "./state.js";
import { showToast } from "./toast.js";
import { showConfirmDialog, showPromptDialog } from "./dialog.js";
import { skillContentFingerprint } from "./skill-import-model.js";
import {
  pageKey, tableCandidates, resolveTableFromTarget, extractHeaders, describeTable,
  headerSimilarity, resolveStoredSource, extractStoredSourceData, inspectStoredSourcePagination
} from "./skill-source-dom.js";
import {
  collectStoredSourceData, stopStoredSourceCollection, findStoredSourceTable
} from "./skill-collector.js";

const STORAGE_KEY = "web2aiSkills";
const PAGE_NAMES_STORAGE_KEY = "web2aiSkillPageNames";
let renderCallback = () => void 0;
let activePickSession = "";
let cancelActivePick = null;
let observedPageKey = "";
let pageWatchTimer = null;
let skillBarTimer = null;
let skillBarBroadcastTimer = null;
let skillValidationRunId = 0;
let lastSkillBarDiagnostic = "";
let lastSkillBarDiagnosticAt = 0;
let activeBusinessTabTitle = "";
let confirmedBusinessTabTitle = "";
let pendingBusinessTabTitle = "";
let businessTabClickListenerInstalled = false;
// 技能采集诊断默认跟随内容脚本 DEBUG。日志只输出 frame、DOM 特征、
// 页码、滚动尺寸和行数，不输出业务单元格内容。
const SKILL_DIAGNOSTICS = DEBUG;
const SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS = [400, 900, 1600, 2400];

function readBusinessPageTabs() {
  const titles = Array.from(document.querySelectorAll('[class*="realTab"]'))
    .filter((element) => String(element.className || "").split(/\s+/).some((name) => name.endsWith("-realTab")))
    .map((element) => compactOneLine(element.textContent || ""))
    .filter(Boolean);
  const uniqueTitles = [...new Set(titles)];
  return {
    titles: uniqueTitles,
    activeTitle: uniqueTitles.includes(confirmedBusinessTabTitle)
      ? confirmedBusinessTabTitle
      : uniqueTitles[uniqueTitles.length - 1] || "",
    activeTitleConfirmed: Boolean(confirmedBusinessTabTitle && uniqueTitles.includes(confirmedBusinessTabTitle))
  };
}

function getBusinessPageTabs() {
  return readBusinessPageTabs();
}

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

function focusStoredSource(source) {
  const table = findStoredSourceTable(source);
  if (!table) return { found: false, candidateCount: tableCandidates().length };
  const similarity = source?.headers?.length
    ? headerSimilarity(source.headers, extractHeaders(table))
    : 1;
  if (source?.headers?.length && similarity < 0.8) {
    return { found: false, candidateCount: tableCandidates().length, similarity };
  }
  const bar = table.previousElementSibling?.matches?.("[data-web2ai-skill-bar]")
    ? table.previousElementSibling
    : null;
  const target = bar || table;
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  const oldOutline = target.style.outline;
  const oldOutlineOffset = target.style.outlineOffset;
  target.style.outline = "3px solid #3b82f6";
  target.style.outlineOffset = "3px";
  setTimeout(() => {
    target.style.outline = oldOutline;
    target.style.outlineOffset = oldOutlineOffset;
  }, 1800);
  return { found: true, similarity };
}

function renderSkillBars(skills = []) {
  document.querySelectorAll("[data-web2ai-skill-bar]").forEach((node) => node.remove());
  const grouped = new Map();
  const probes = [];
  for (const skill of skills) {
    for (const source of (Array.isArray(skill.pageSources) ? skill.pageSources : skillSources(skill))) {
      const expectedFrameUrl = pageKey(source.frameUrl || "");
      const table = findStoredSourceTable(source);
      const similarity = table ? headerSimilarity(source.headers || [], extractHeaders(table)) : 0;
      const frameMatches = !expectedFrameUrl || expectedFrameUrl === pageKey(location.href);
      probes.push({
        skillId: skill.id,
        skillName: skill.name,
        sourceId: source.id,
        expectedFrameUrl,
        frameMatches,
        foundTable: Boolean(table),
        similarity: Number(similarity.toFixed(3))
      });
      if (!table || !frameMatches) continue;
      const list = grouped.get(table) || [];
      if (!list.some((item) => item.id === skill.id)) list.push(skill);
      grouped.set(table, list);
    }
  }
  for (const [table, tableSkills] of grouped) {
    const bar = document.createElement("div");
    bar.dataset.web2aiSkillBar = "1";
    bar.dataset.web2aiUi = "1";
    Object.assign(bar.style, {
      display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
      boxSizing: "border-box", width: "100%", margin: "0 0 8px", padding: "8px 10px",
      border: "1px solid #bfdbfe", borderRadius: "9px", background: "#eff6ff",
      color: "#1e3a8a", fontFamily: "system-ui,-apple-system,sans-serif", fontSize: "12px"
    });
    const label = document.createElement("span");
    label.textContent = "技能列表：";
    Object.assign(label.style, { fontWeight: "700", marginRight: "2px", whiteSpace: "nowrap" });
    bar.appendChild(label);
    for (const skill of tableSkills) {
      const item = document.createElement("span");
      Object.assign(item.style, {
        display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "100%",
        padding: "4px 5px 4px 8px", border: "1px solid #dbeafe", borderRadius: "8px", background: "#fff"
      });
      const name = document.createElement("span");
      name.textContent = skill.name;
      name.title = skill.name;
      Object.assign(name.style, { maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      const button = document.createElement("button");
      const canExecute = Boolean(buildAnalysisPrompt(skill.analysisMethod));
      button.textContent = "执行";
      button.disabled = !canExecute;
      button.title = canExecute ? `执行技能：${skill.name}` : "请先配置分析方法";
      Object.assign(button.style, {
        height: "24px", padding: "0 8px", border: "0", borderRadius: "7px",
        background: canExecute ? "#2563eb" : "#cbd5e1", color: "#fff", cursor: canExecute ? "pointer" : "not-allowed", fontSize: "11px"
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chrome.runtime.sendMessage({ type: "EXECUTE_SKILL_FROM_PAGE", skillId: skill.id }).catch(() => void 0);
      });
      item.append(name, button);
      bar.appendChild(item);
    }
    table.parentNode?.insertBefore(bar, table);
  }
  const diagnostic = JSON.stringify({
    frame: IS_TOP_FRAME ? "top" : "child",
    frameUrl: pageKey(location.href),
    skillCount: skills.length,
    matchedSourceCount: grouped.size,
    barCount: document.querySelectorAll("[data-web2ai-skill-bar]").length,
    tableCandidateCount: tableCandidates().length,
    probes
  });
  const now = Date.now();
  const hasUnmatchedSkills = skills.length > 0 && grouped.size === 0;
  if (diagnostic !== lastSkillBarDiagnostic || (hasUnmatchedSkills && now - lastSkillBarDiagnosticAt >= 10000)) {
    lastSkillBarDiagnostic = diagnostic;
    lastSkillBarDiagnosticAt = now;
    if (hasUnmatchedSkills) {
      SKILL_DIAGNOSTICS && console.warn("[web2ai.skill-bar] sync", diagnostic);
    } else {
      SKILL_DIAGNOSTICS && console.info("[web2ai.skill-bar] sync", diagnostic);
    }
  }
}

function scheduleSkillBars(skills = []) {
  if (skillBarTimer) clearInterval(skillBarTimer);
  if (skillBarBroadcastTimer) clearInterval(skillBarBroadcastTimer);
  skillBarTimer = null;
  skillBarBroadcastTimer = null;
  renderSkillBars(skills);
  if (skills.length) {
    // 业务表可能在页面加载十几秒后才出现，也可能被 SPA/虚拟列表整体替换。
    // 低频重建只在当前页面存在技能时运行，确保横条最终出现并持续存在。
    skillBarTimer = setInterval(() => renderSkillBars(skills), 3000);
    if (IS_TOP_FRAME) {
      // 子 frame 的 main.js 通过动态 import 初始化，首次广播可能早于监听器注册。
      // 顶层低频重发，使延迟加载、重新导航或后创建的 iframe 最终都能收到技能列表。
      skillBarBroadcastTimer = setInterval(() => {
        chrome.runtime.sendMessage({
          type: "BROADCAST_TO_TAB",
          payload: { message: { type: "SYNC_SKILL_BARS", skills } }
        }).catch(() => void 0);
      }, 3000);
    }
  }
}

async function readSkills() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const stored = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  // 读取时只做结构兼容，绝不回写或重新生成已经保存的数据源名称。
  return stored.map(normalizeStoredSkill);
}

async function mutateSkills(mutation) {
  const response = await chrome.runtime.sendMessage({ type: "MUTATE_SKILLS", mutation });
  if (!response?.ok) {
    const error = new Error(response?.error || "技能保存失败");
    error.code = response?.code || "SKILL_MUTATION_FAILED";
    throw error;
  }
  return response.data;
}

async function downloadSkillsExport() {
  const [skills, pageNamesData] = await Promise.all([
    readSkills(),
    chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY])
  ]);
  const payload = {
    format: "web2ai-skills",
    version: 1,
    exportedAt: new Date().toISOString(),
    skills,
    pageNames: pageNamesData[PAGE_NAMES_STORAGE_KEY] || {}
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `web2ai-skills-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return skills.length;
}

async function previewSkillsImport(text) {
  if (String(text || "").length > 5 * 1024 * 1024) throw new Error("导入文件不能超过 5MB");
  let parsed;
  try { parsed = JSON.parse(String(text || "")); } catch { throw new Error("文件不是有效的 JSON"); }
  const rawSkills = Array.isArray(parsed) ? parsed : parsed?.skills;
  if (!Array.isArray(rawSkills) || !rawSkills.length) throw new Error("文件中没有可导入的技能");
  if (rawSkills.length > 500) throw new Error("一次最多导入 500 个技能");
  const existing = await readSkills();
  const seenFingerprints = new Set(existing.map(skillContentFingerprint));
  const imported = [];
  const failures = [];
  let duplicate = 0;
  rawSkills.forEach((raw, skillIndex) => {
    try {
      const normalized = normalizeStoredSkill(raw);
      const name = compactOneLine(normalized?.name);
      const sources = skillSources(normalized);
      if (!name) throw new Error("缺少技能名称");
      if (!sources.length) throw new Error("没有数据源");
      for (const source of sources) {
        if (!source.pageKey || !Array.isArray(source.headers) || !source.headers.length || (!source.selector && !Number.isInteger(source.tableIndex))) {
          throw new Error("包含无效的数据源绑定");
        }
      }
      const candidate = { ...normalized, name, sources, source: sources[0] };
      const fingerprint = skillContentFingerprint(candidate);
      if (seenFingerprints.has(fingerprint)) {
        duplicate++;
        return;
      }
      seenFingerprints.add(fingerprint);
      const id = uid();
      const importedSources = sources.map((source, sourceIndex) => ({
        ...source,
        id: `source_${id}_${sourceIndex + 1}`
      }));
      imported.push({
        ...candidate,
        id,
        sources: importedSources,
        source: importedSources[0],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    } catch (error) {
      failures.push({
        index: skillIndex + 1,
        name: compactOneLine(raw?.name) || `第 ${skillIndex + 1} 个技能`,
        error: String(error?.message ?? error)
      });
    }
  });
  const pageNames = parsed?.pageNames && typeof parsed.pageNames === "object" && !Array.isArray(parsed.pageNames)
    ? Object.fromEntries(Object.entries(parsed.pageNames).filter(([key, value]) => key && typeof value === "string"))
    : {};
  return {
    skills: imported,
    pageNames,
    total: rawSkills.length,
    success: imported.length,
    duplicate,
    failed: failures.length,
    failures
  };
}

async function applySkillsImport(preview) {
  // 预览和最终确认之间其他页面可能已经导入或修改技能。background 会在
  // 串行 mutation 中基于最新集合再次去重，避免覆盖或重复写入。
  const result = await mutateSkills({
    type: "IMPORT_SKILLS",
    skills: preview.skills,
    pageNames: preview.pageNames || {}
  });
  await loadSkills();
  await chrome.runtime.sendMessage({ type: "REFRESH_SKILLS_ALL_TABS" }).catch(() => void 0);
  const success = Number(result?.added) || 0;
  return {
    total: preview.total,
    success,
    duplicate: preview.duplicate + Math.max(0, preview.success - success),
    failed: preview.failed
  };
}

function autoSourceDisplayName(source, index = 0) {
  const direct = compactOneLine(source.tableTitle || source.businessTabTitle || "");
  if (direct) return direct;
  const ignored = /^(序号|操作|选择|全选|checkbox)$/i;
  const representativeHeaders = (source.headers || []).map(compactOneLine).filter((header) => header && !ignored.test(header)).slice(0, 2);
  if (representativeHeaders.length) return `${representativeHeaders.join("、")}${representativeHeaders.length > 1 ? "等数据" : "数据"}`;
  return `数据源 ${index + 1}`;
}

function normalizeSkillSource(source, index = 0) {
  if (!source || typeof source !== "object") return null;
  const frameId = Number(source.frameId) || 0;
  const normalizedFrameUrl = pageKey(source.frameUrl || "");
  // 非历史迁移数据中，顶层 frame 的地址必然就是数据源所属页面。
  // 这也会在加载时自动修复曾因 tab.url 与 sender.url 不同步而保存错页的数据源。
  const repairTopFrameOwnership = frameId === 0 && !source.legacyPageOwnership && /^https?:\/\//.test(normalizedFrameUrl);
  const sourcePageUrl = repairTopFrameOwnership ? (source.frameUrl || normalizedFrameUrl) : (source.pageUrl || source.frameUrl || "");
  const storedDisplayName = compactOneLine(source.displayName || source.sourceName || source.pageTitle || "");
  // 名称是绑定时的用户可见快照。只在首次绑定且完全没有历史名称时生成，
  // 页面标题、业务 Tab 或表头后续变化都不能隐式改名。
  const hasStoredDisplayName = Boolean(storedDisplayName);
  return {
    ...source,
    frameId,
    id: source.id || uid(),
    displayName: hasStoredDisplayName ? storedDisplayName : autoSourceDisplayName(source, index),
    displayNameCustomized: source.displayNameCustomized === true,
    displayNameOrigin: source.displayNameOrigin || (hasStoredDisplayName ? "recorded" : "auto"),
    pageKey: repairTopFrameOwnership ? normalizedFrameUrl : (source.pageKey || pageKey(sourcePageUrl)),
    pageUrl: sourcePageUrl
  };
}

function skillSources(skill) {
  const values = Array.isArray(skill?.sources) && skill.sources.length ? skill.sources : (skill?.source ? [skill.source] : []);
  return values.map((source, index) => normalizeSkillSource({
    ...source,
    id: source?.id || (skill?.id ? `source_${skill.id}_${index + 1}` : "")
  }, index)).filter(Boolean);
}

function normalizeStoredSkill(skill) {
  if (!skill || typeof skill !== "object") return skill;
  const sources = skillSources(skill).map((source, index) => {
    const migrationId = skill.id ? `source_${skill.id}_${index + 1}` : "";
    // 修复上一版从旧 `source` 推导 pageKey 时误用了 frameUrl 的记录。
    // 迁移生成的稳定 ID 只代表历史数据源，原始归属必须以 skill.pageKey 为准。
    if (source.id === migrationId) {
      return { ...source, pageKey: skill.pageKey || source.pageKey, pageUrl: skill.pageUrl || source.pageUrl, legacyPageOwnership: true };
    }
    return source;
  });
  const primarySource = sources[0] || null;
  const sourcePageKeys = new Set(sources.map((source) => source.pageKey).filter(Boolean));
  // 独立编辑器早期版本曾把“创建入口页”误存为技能主页面。
  // 当主页面不属于任何数据源时，可确定为错归属并安全迁移到第一个数据源页面。
  const repairPrimaryPage = Boolean(primarySource?.pageKey && !sourcePageKeys.has(skill.pageKey));
  return {
    ...skill,
    version: Math.max(3, Number(skill.version) || 1),
    revision: Math.max(0, Number(skill.revision) || 0),
    pageKey: repairPrimaryPage ? primarySource.pageKey : skill.pageKey,
    pageUrl: repairPrimaryPage ? (primarySource.pageUrl || skill.pageUrl) : skill.pageUrl,
    pageTitle: repairPrimaryPage ? (primarySource.pageTitle || skill.pageTitle) : skill.pageTitle,
    sourceName: primarySource?.displayName || skill.sourceName,
    sources,
    source: primarySource
  };
}

async function loadSkills() {
  if (!IS_TOP_FRAME) return;
  const validationRunId = ++skillValidationRunId;
  const [all, pageNamesData] = await Promise.all([
    readSkills(),
    chrome.storage.local.get([PAGE_NAMES_STORAGE_KEY])
  ]);
  const businessTabs = readBusinessPageTabs();
  activeBusinessTabTitle = businessTabs.activeTitle;
  const currentPageKey = pageKey();
  // 加载和查看技能必须是只读的。历史数据源缺少业务 Tab 标题时，只能在
  // validateSkillSource 已经唯一定位成功后，通过目标 source mutation 补齐。
  STATE.skillPageNames = pageNamesData[PAGE_NAMES_STORAGE_KEY] && typeof pageNamesData[PAGE_NAMES_STORAGE_KEY] === "object"
    ? pageNamesData[PAGE_NAMES_STORAGE_KEY]
    : {};
  STATE.skillCatalog = all;
  STATE.skills = all.filter((skill) => skill.pageKey === currentPageKey || skill.sources.some((source) => source.pageKey === currentPageKey))
    .map((skill) => ({
      ...skill,
      // 横条渲染只能看到当前顶层页面的数据源，不能拿其他页面的相似表格兜底。
      pageSources: skill.sources.filter((source) => source.pageKey === currentPageKey || (!source.pageKey && skill.pageKey === currentPageKey))
    }));
  STATE.skillSourceStatuses = Object.fromEntries(STATE.skills.map((skill) => [
    skill.id,
    Object.fromEntries(skill.sources.map((source) => [source.id, { status: "checking" }]))
  ]));
  renderCallback();
  scheduleSkillBars(STATE.skills);
  chrome.runtime.sendMessage({
    type: "BROADCAST_TO_TAB",
    payload: { message: { type: "SYNC_SKILL_BARS", skills: STATE.skills } }
  }).catch(() => void 0);
  await Promise.all(STATE.skills.map((skill) => validateSkillSource(skill, validationRunId)));
}

function createSkillDraft() {
  STATE.skillDraft = { id: "", revision: 0, name: "", sources: [], analysisMethod: emptyAnalysisMethod() };
  STATE.activePanelTab = "skills";
  STATE.open = true;
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
  renderCallback();
}

function cancelSkillDraft() {
  STATE.skillDraft = null;
  renderCallback();
}

async function selectSkillTable(sourceId = "") {
  if (!STATE.skillDraft) STATE.skillDraft = { id: "", revision: 0, name: "", sources: [], analysisMethod: emptyAnalysisMethod() };
  const sessionId = uid();
  STATE.skillPicking = true;
  STATE.skillPickSession = sessionId;
  STATE.skillPickSourceId = sourceId;
  STATE.open = false;
  renderCallback();
  await chrome.runtime.sendMessage({
    type: "START_SKILL_SOURCE_PICK",
    sessionId
  });
}

async function startSkillCreation() {
  createSkillDraft();
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
    if (event.button !== 0) return;
    const clickedTable = hovered || resolveTableFromTarget(event.target);
    if (!clickedTable) {
      const target = event.target instanceof Element ? event.target : null;
      const drawer = target?.closest?.(".ant-drawer,.ant-modal,.arco-drawer,.arco-modal,[role='dialog'],[class*='drawer' i],[class*='modal' i]");
      SKILL_DIAGNOSTICS && console.info("[web2ai.skill-pick] unresolved click", JSON.stringify({
        frame: IS_TOP_FRAME ? "top" : "child",
        frameUrl: pageKey(location.href),
        target: target ? `${target.tagName.toLowerCase()}#${target.id || ""}.${String(target.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 5).join(".")}` : "none",
        inDrawer: Boolean(drawer),
        drawer: drawer ? `${drawer.tagName.toLowerCase()}#${drawer.id || ""}.${String(drawer.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 5).join(".")}` : "none",
        candidateCount: tableCandidates().length
      }));
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    sendResult({ source: describeTable(clickedTable, event.target instanceof Element ? event.target : hoveredTarget) });
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
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
  refs.suppressPanelCloseUntil = Date.now() + 1000;
  if (refs.panelCloseTimer) clearTimeout(refs.panelCloseTimer);
  refs.panelCloseTimer = null;
  if (payload.cancelled) {
    showToast("已取消选择数据源");
  } else if (payload.source) {
    STATE.skillDraft ||= { id: "", revision: 0, name: "", sources: [], analysisMethod: emptyAnalysisMethod() };
    const selectedSource = {
      ...payload.source,
      id: STATE.skillPickSourceId || uid(),
      frameId: payload.frameId || 0,
      frameUrl: payload.frameUrl || payload.source.frameUrl,
      pageKey: payload.pageKey || payload.source.pageKey,
      pageUrl: payload.pageUrl || payload.source.pageUrl
    };
    if (!compactOneLine(selectedSource.displayName || "")) {
      selectedSource.displayName = autoSourceDisplayName(selectedSource, STATE.skillDraft.sources.length);
      selectedSource.displayNameOrigin = "auto";
    }
    const source = normalizeSkillSource(selectedSource, STATE.skillDraft.sources.length);
    // “添加数据源”和用户主动“重新选择”走同一套快照逻辑：名称、页面
    // 展示信息和表头都以本次明确选择为准。日常读取与校验仍不会自动改名。
    if (!source.displayNameCustomized) {
      const baseName = source.displayName;
      const sameNameCount = STATE.skillDraft.sources.filter((item) => (
        item.id !== STATE.skillPickSourceId &&
        (item.displayName === baseName || item.displayName?.startsWith(`${baseName}（`))
      )).length;
      if (sameNameCount) source.displayName = `${baseName}（${sameNameCount + 1}）`;
    }
    const duplicateIndex = STATE.skillDraft.sources.findIndex((item) => (
      item.id !== STATE.skillPickSourceId && item.pageKey === source.pageKey &&
      item.frameUrl === source.frameUrl && item.selector === source.selector &&
      Number(item.tableIndex) === Number(source.tableIndex)
    ));
    if (duplicateIndex >= 0) {
      SKILL_DIAGNOSTICS && console.info("[web2ai.skill-pick] duplicate source", JSON.stringify({
        existingSourceId: STATE.skillDraft.sources[duplicateIndex].id,
        selectedSourceId: source.id,
        pageKey: source.pageKey,
        frameUrl: source.frameUrl,
        selector: source.selector,
        tableIndex: source.tableIndex
      }));
      showToast("该数据源已经添加");
    } else if (STATE.skillPickSourceId) {
      const index = STATE.skillDraft.sources.findIndex((item) => item.id === STATE.skillPickSourceId);
      if (index >= 0) STATE.skillDraft.sources[index] = source;
    } else {
      STATE.skillDraft.sources.push(source);
    }
  }
  STATE.skillPickSourceId = "";
  renderCallback();
}

function removeSkillDraftSource(sourceId) {
  if (!STATE.skillDraft) return;
  STATE.skillDraft.sources = STATE.skillDraft.sources.filter((source) => source.id !== sourceId);
  renderCallback();
}

async function saveSkillDraft() {
  const draft = STATE.skillDraft;
  if (!draft?.sources?.length) return showToast("请至少选择一个数据源");
  if (!String(draft.name).trim()) return showToast("请填写技能名称");
  const all = await readSkills();
  const now = Date.now();
  const existing = all.find((skill) => skill.id === draft.id);
  const primarySource = normalizeSkillSource(draft.sources[0]);
  const skill = {
    id: draft.id || uid(),
    version: 3,
    name: String(draft.name).trim(),
    // 创建/修改期间可能跨多个页面选表，技能主归属始终跟随第一个数据源。
    pageKey: primarySource.pageKey || existing?.pageKey || pageKey(),
    pageUrl: primarySource.pageUrl || existing?.pageUrl || location.href,
    pageTitle: primarySource.pageTitle || existing?.pageTitle || document.title,
    sourceName: primarySource.displayName,
    sources: draft.sources.map(normalizeSkillSource),
    source: primarySource,
    analysisMethod: normalizeAnalysisMethod(draft.analysisMethod),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  SKILL_DIAGNOSTICS && console.info("[web2ai.skill] saved skill", JSON.stringify({
    skillId: skill.id,
    skillName: skill.name,
    primaryPageKey: skill.pageKey,
    sourceCount: skill.sources.length,
    sources: skill.sources.map((source) => ({
      sourceId: source.id,
      pageKey: source.pageKey,
      frameId: source.frameId,
      frameUrl: source.frameUrl,
      selector: source.selector,
      tableIndex: source.tableIndex,
      headerCount: source.headers?.length || 0
    }))
  }));
  try {
    await mutateSkills({
      type: "UPSERT_SKILL",
      skill,
      expectedRevision: Math.max(0, Number(draft.revision) || 0)
    });
  } catch (error) {
    if (error?.code === "SKILL_CONFLICT") {
      showToast("该技能已在其他页面修改。当前草稿已保留，请重新打开最新技能后再编辑。", 4500, { position: "center" });
      return;
    }
    throw error;
  }
  STATE.skillDraft = null;
  STATE.open = true;
  STATE.activePanelTab = "skills";
  await loadSkills();
  await chrome.runtime.sendMessage({ type: "REFRESH_SKILLS_ALL_TABS" }).catch(() => void 0);
  showToast(existing ? "技能已修改" : "技能已保存");
}

async function saveSkillAnalysisMethod(id, description) {
  const current = STATE.skillCatalog.find((item) => item.id === id);
  const skill = await mutateSkills({
    type: "UPDATE_ANALYSIS_METHOD",
    skillId: id,
    // 若当前页面目录尚未同步到该技能，也用 0 参与比较；不能因缺少本地
    // revision 就绕过冲突保护并覆盖 background 中的新版本。
    expectedRevision: current?.revision ?? 0,
    analysisMethod: normalizeAnalysisMethod({ description })
  });
  // mutation 返回时 storage 已经持久化成功。先同步本页 revision 和分析方法，
  // 不把随后可能持续数秒的数据源校验算进“保存”操作；storage.onChanged 会
  // 继续触发完整目录刷新和校验。
  STATE.skillCatalog = STATE.skillCatalog.map((item) => item.id === id ? normalizeStoredSkill(skill) : item);
  STATE.skills = STATE.skills.map((item) => item.id === id ? { ...item, ...normalizeStoredSkill(skill) } : item);
  renderCallback();
  return skill;
}

async function updateSkillSourceHeaders(skillId, sourceId, headers) {
  const normalizedHeaders = Array.isArray(headers) ? headers.map((header) => compactOneLine(header)).filter(Boolean) : [];
  if (!normalizedHeaders.length) throw new Error("未识别到新的数据源字段");
  const current = STATE.skillCatalog.find((item) => item.id === skillId);
  const skill = await mutateSkills({
    type: "UPDATE_SOURCE_HEADERS",
    skillId,
    sourceId,
    expectedRevision: current?.revision ?? 0,
    headers: normalizedHeaders
  });
  await loadSkills();
  return skill?.sources?.find((item) => item.id === sourceId);
}

function rebindSkill(id) {
  const skill = STATE.skillCatalog.find((item) => item.id === id);
  if (!skill) return;
  STATE.skillDraft = {
    id: skill.id,
    revision: skill.revision || 0,
    name: skill.name,
    sources: skillSources(skill),
    analysisMethod: normalizeAnalysisMethod(skill.analysisMethod),
    createdAt: skill.createdAt || 0
  };
  STATE.activePanelTab = "skills";
  STATE.open = true;
  chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0);
  renderCallback();
}

async function deleteSkill(id) {
  const current = STATE.skillCatalog.find((skill) => skill.id === id);
  try {
    await mutateSkills({ type: "DELETE_SKILL", skillId: id, expectedRevision: current?.revision ?? 0 });
    await loadSkills();
  } catch (error) {
    showToast(`删除失败：${String(error?.message ?? error)}`, 3500, { position: "center" });
  }
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
  await mutateSkills({ type: "DELETE_ALL_SKILLS" });
  renderCallback();
  showToast("全部技能已删除");
}

async function switchToSkillPage(targetPageKey, targetUrl, source = null) {
  let response = await chrome.runtime.sendMessage({
    type: "SWITCH_TO_SKILL_PAGE",
    pageKey: targetPageKey,
    pageUrl: targetUrl,
    source
  }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  if (!response?.ok && response?.code === "PAGE_NOT_OPEN") {
    const accepted = await showConfirmDialog("该技能页面当前没有保持打开，是否在当前标签页打开？");
    if (!accepted) return;
    response = await chrome.runtime.sendMessage({
      type: "SWITCH_TO_SKILL_PAGE",
      pageKey: targetPageKey,
      pageUrl: targetUrl,
      source,
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
  await mutateSkills({ type: "SET_PAGE_NAME", pageKey: currentPageKey, name: nextName });
  STATE.skillPageNames = { ...STATE.skillPageNames, [currentPageKey]: nextName };
  renderCallback();
  showToast("页面名称已修改");
}

async function validateSkillSource(skill, validationRunId = skillValidationRunId) {
  const statuses = {};
  await Promise.all(skill.sources.map(async (source) => {
    if (source.pageKey !== pageKey()) {
      statuses[source.id] = { status: "deferred", found: false };
      return;
    }
    try {
      let validated = null;
      for (let attempt = 0; attempt <= SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS.length; attempt++) {
        const response = await chrome.runtime.sendMessage({ type: "VALIDATE_SKILL_SOURCE", source });
        validated = response?.data || { status: "missing" };
        // 站点慢加载时，首轮常出现“表格尚未挂载”；给一个短暂重试窗口避免误报失效。
        if (validated.found || validated.status === "changed") break;
        if (attempt >= SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS.length) break;
        await new Promise((resolve) => setTimeout(resolve, SKILL_SOURCE_VALIDATE_RETRY_DELAYS_MS[attempt]));
      }
      statuses[source.id] = validated || { status: "missing" };
      // 兼容旧技能：只有当前 source 已被现有严格定位规则唯一确认，且业务 Tab
      // 来自明确点击后的确认状态时，才填补缺失标题；绝不覆盖已有绑定。
      const businessTabs = readBusinessPageTabs();
      if (statuses[source.id]?.found && !source.businessTabTitle && businessTabs.activeTitleConfirmed && businessTabs.activeTitle) {
        const updated = await mutateSkills({
          type: "LEARN_SOURCE_BUSINESS_TAB",
          skillId: skill.id,
          sourceId: source.id,
          title: businessTabs.activeTitle
        }).catch(() => null);
        const updatedSource = updated?.sources?.find((item) => item.id === source.id);
        if (updatedSource?.businessTabTitle) {
          source.businessTabTitle = updatedSource.businessTabTitle;
          source.businessTabTitleConfirmed = true;
        }
      }
      if (!statuses[source.id]?.found) {
        SKILL_DIAGNOSTICS && console.info("[web2ai.skill] validation result", JSON.stringify({
          skillId: skill.id,
          skillName: skill.name,
          sourceId: source.id,
          status: statuses[source.id]?.status || "missing",
          sourceFrameUrl: pageKey(source.frameUrl || ""),
          probes: statuses[source.id]?.probes || []
        }));
      }
    } catch {
      statuses[source.id] = { status: "missing" };
    }
  }));
  // 页面切换会同时产生多轮异步校验；旧页面较晚返回时不能覆盖新页面状态。
  if (validationRunId !== skillValidationRunId || !STATE.skills.some((item) => item.id === skill.id)) return;
  STATE.skillSourceStatuses[skill.id] = statuses;
  renderCallback();
}

function initSkills(onRender) {
  renderCallback = onRender || renderCallback;
  if (IS_TOP_FRAME && !businessTabClickListenerInstalled) {
    businessTabClickListenerInstalled = true;
    document.addEventListener("click", (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[class*="realTab"]') : null;
      if (!tab || !String(tab.className || "").split(/\s+/).some((name) => name.endsWith("-realTab"))) return;
      pendingBusinessTabTitle = compactOneLine(tab.textContent || "");
    }, true);
  }
  if (IS_TOP_FRAME && !pageWatchTimer) {
    observedPageKey = pageKey();
    // SPA 的 pushState/replaceState 不会重新执行 content script，也没有统一事件。
    // 轮询规范化后的页面键可同时覆盖 history API、前进后退和站点自定义路由。
    pageWatchTimer = setInterval(() => {
      const currentPageKey = pageKey();
      if (currentPageKey === observedPageKey) return;
      if (currentPageKey !== observedPageKey) {
        confirmedBusinessTabTitle = pendingBusinessTabTitle || "";
        pendingBusinessTabTitle = "";
      }
      observedPageKey = currentPageKey;
      // 查看模式跟随业务路由刷新；新建/修改模式必须保留草稿，
      // 页面切换只用于选择跨页面数据源，不能中断正在进行的编辑。
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
  saveSkillDraft, rebindSkill, removeSkillDraftSource, deleteSkill, deleteAllSkills, resolveStoredSource, switchToSkillPage,
  renameCurrentSkillPage, buildAnalysisPrompt,
  extractStoredSourceData, inspectStoredSourcePagination, collectStoredSourceData, stopStoredSourceCollection, focusStoredSource,
  saveSkillAnalysisMethod, updateSkillSourceHeaders, scheduleSkillBars,
  downloadSkillsExport, previewSkillsImport, applySkillsImport, getBusinessPageTabs
};
