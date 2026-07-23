/**
 * @fileoverview AI 对话浮层 UI。
 *
 * 职责：
 * - 渲染侧边栏聊天面板（Shadow DOM 隔离样式）
 * - 管理对话消息列表、输入框、流式渲染
 * - 上下文片段列表渲染（按表格分组）
 * - 区域/多屏截图流程与截图上下文
 * - 技能创建/目录，以及测试与执行工作台的 Shadow DOM 外壳
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
import { addContextSnippet, removeContext, clearContext, clearAll, buildContextBlock } from './context.js';
import { calculateContextBudget, estimateTokens, selectContextsWithinTokenBudget } from './token-budget.js';
import { tableGroupToCsv, tableGroupToMarkdown } from './table-export.js';
import { buildOnboardingPrompt, createFallbackOnboarding, parseOnboardingResponse } from './onboarding.js';
import { highlightRow, removePinnedRowOverlay, syncRowCheckboxState, updateBatchBar, hideTableRowFab, ensureTableRowFab, setTableAskAiEnabled, setTableSelectionEnabled } from './table.js';
import { showToast } from './toast.js';
import { showConfirmDialog, showPromptDialog } from './dialog.js';
import { createSkillDraft, cancelSkillDraft, selectSkillTable, saveSkillDraft, rebindSkill, removeSkillDraftSource, deleteSkill, deleteAllSkills, switchToSkillPage, renameCurrentSkillPage, buildAnalysisPrompt, downloadSkillsExport, previewSkillsImport, applySkillsImport } from './skills.js';
import {
  DEFAULT_DERIVED_METHOD_VERSION,
  SKILL_TYPE_DERIVED_COLUMN,
  SKILL_TYPE_TABLE_ANALYSIS,
  normalizeDerivedColumnOutput,
  normalizeDerivedColumnSelections,
  normalizeDerivedColumnSkill,
  normalizedHeaderText,
  skillTypeOf
} from './derived-column-model.js';
import {
  initSkillWorkspaceController, startDerivedColumnPreview, startSkillExecution, startSkillTest
} from './skill-workspace-controller.js';
import { SKILL_WORKSPACE_CSS } from './skill-workspace-style.js';
import { renderSkillWorkspace } from './skill-workspace-view.js';

const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; right: 0; top: 0; bottom: 0; width: 500px; height: 100vh; pointer-events: auto; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .wrap.max { left: 0; right: 0; width: 100vw; }
    .card { height: 100%; display: flex; flex-direction: column; background: rgba(255,255,255,0.98); border-left: 1px solid rgba(0,0,0,0.12); overflow: hidden; box-shadow: 0 12px 36px rgba(0,0,0,0.22); backdrop-filter: blur(10px); }
    .workspace { flex: 1; min-height: 0; display: flex; }
    .tableAskToggle { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: #475569; font-size: 11px; font-weight: 650; cursor: pointer; user-select: none; }
    .tableAskToggle input { width: 30px; height: 16px; margin: 0; appearance: none; border: 1px solid #cbd5e1; border-radius: 999px; background: #e2e8f0; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
    .tableAskToggle input::before { content: ""; display: block; width: 12px; height: 12px; margin: 1px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,.28); transition: transform .15s ease; }
    .tableAskToggle input:checked { border-color: #2563eb; background: #2563eb; }
    .tableAskToggle input:checked::before { transform: translateX(14px); }
    .sideTabs { width: 48px; flex: 0 0 48px; padding: 10px 6px; display: flex; flex-direction: column; gap: 7px; background: #f8fafc; border-right: 1px solid rgba(0,0,0,.08); }
    .sideTab { min-height: 44px; padding: 5px 2px; border: 0; border-radius: 9px; background: transparent; color: #64748b; font-size: 11px; cursor: pointer; }
    .sideTab.active { background: #dbeafe; color: #1d4ed8; font-weight: 650; }
    .mainPane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .wrap.max .card { border-left: none; box-shadow: none; }
    .hidden { display: none; }
    .header { display: flex; flex-direction: column; gap: 7px; padding: 10px; border-bottom: 1px solid rgba(0,0,0,0.08); }
    .headerRow { width: 100%; display: flex; align-items: center; gap: 6px; }
    .title { font-weight: 650; font-size: 13px; color: #111827; flex: 1; }
    .header .btn-primary { font-weight: 600; }
    .btn { height: 28px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.12); background: #fff; color: #111827; padding: 0 10px; cursor: pointer; font-size: 12px; }
    .btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
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
    .contextScreenshot { display: block; width: 100%; max-height: 180px; object-fit: contain; border-radius: 8px; background: #f3f4f6; border: 1px solid rgba(0,0,0,.08); }
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
    .bubble.waiting { display: flex; align-items: center; gap: 7px; color: #64748b; }
    .waitingDots { display: inline-flex; gap: 3px; }
    .waitingDots i { width: 5px; height: 5px; border-radius: 50%; background: #64748b; animation: web2aiWaiting 1.1s infinite ease-in-out; }
    .waitingDots i:nth-child(2) { animation-delay: .16s; }
    .waitingDots i:nth-child(3) { animation-delay: .32s; }
    @keyframes web2aiWaiting { 0%, 70%, 100% { opacity: .3; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-2px); } }
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
    .composerMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .composerMain textarea { width: 100%; box-sizing: border-box; flex: none; }
    textarea { flex: 1; resize: none; height: 92px; border-radius: 12px; border: 1px solid rgba(0,0,0,0.14); padding: 8px 10px; font-size: 12px; outline: none; background: #fff; color: #111827; }
    textarea:focus { border-color: rgba(59,130,246,0.7); box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
    .composerActions { width: 92px; display: flex; flex-direction: column; gap: 8px; }
    .composerActions .btn { width: 100%; }
    .skillBody { flex: 1; min-height: 0; padding: 10px; overflow: auto; background: #f8fafc; }
    .skillForm, .skillCard { padding: 11px; margin-bottom: 9px; border: 1px solid rgba(0,0,0,.09); border-radius: 11px; background: #fff; }
    .skillForm { border-color: #93c5fd; }
    .skillFormNotice { margin-bottom: 9px; padding: 10px 11px; border: 1px solid #bfdbfe; border-radius: 11px; background: #eff6ff; color: #1e3a8a; font-size: 11px; line-height: 1.6; }
    .skillTitle { font-size: 12px; font-weight: 650; color: #111827; }
    .skillTypeIcon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      margin-right: 6px;
      padding: 0 6px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 750;
    }
    .skillTypeIcon.table { background: #dbeafe; color: #1d4ed8; }
    .skillTypeIcon.column { background: #ede9fe; color: #7c3aed; }
    .skillNumber { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 20px; margin-right: 7px; border-radius: 6px; background: #fee2e2; color: #b91c1c; font-size: 10px; font-weight: 750; }
    .skillField { display: block; margin-top: 9px; }
    .skillFieldLabel { display: block; margin-bottom: 4px; font-size: 11px; color: #475569; }
    .skillScenarioCard { margin-top: 10px; padding: 12px; border: 1px solid #93c5fd; border-radius: 12px; background: linear-gradient(180deg, #eff6ff 0%, #f8fbff 100%); box-shadow: inset 0 0 0 1px rgba(255,255,255,.55); }
    .skillScenarioTitle { margin-bottom: 6px; color: #1d4ed8; font-size: 11px; font-weight: 750; }
    .skillScenarioText { color: #1e3a8a; font-size: 11px; line-height: 1.65; }
    .skillInput { width: 100%; height: 32px; box-sizing: border-box; border: 1px solid rgba(0,0,0,.14); border-radius: 8px; padding: 0 9px; background: #fff; color: #111827; font-size: 12px; }
    .skillSource { margin-top: 9px; padding: 8px; max-height: 120px; overflow: auto; border: 1px dashed #94a3b8; border-radius: 8px; background: #f8fafc; color: #475569; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
    .skillMeta { margin-top: 5px; color: #64748b; font-size: 10px; line-height: 1.5; }
    .skillActions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 9px; }
    .skillStatus { font-size: 10px; padding: 2px 7px; border-radius: 999px; }
    .skillStatus.available { color: #166534; background: #dcfce7; }
    .skillStatus.changed { color: #9a3412; background: #ffedd5; }
    .skillStatus.ambiguous { color: #9a3412; background: #fef3c7; }
    .skillStatus.missing { color: #b91c1c; background: #fee2e2; }
    .skillStatus.checking { color: #475569; background: #e2e8f0; }
    .skillStatus.deferred { color: #475569; background: #f1f5f9; }
    .skillCreateBar { display: flex; align-items: center; margin-bottom: 10px; }
    .skillList { margin-top: 10px; border: 1px solid rgba(0,0,0,.09); border-radius: 11px; overflow: hidden; background: #fff; }
    .skillSummary { padding: 10px 11px; border-bottom: 1px solid rgba(0,0,0,.07); background: #f8fafc; color: #334155; font-size: 11px; }
    .skillSummaryTitle { display: flex; align-items: center; gap: 8px; font-weight: 650; color: #1e293b; }
    .skillSummaryTitleText { flex: 1; }
    .skillSummaryFooter { display: flex; align-items: center; justify-content: flex-end; height: 26px; margin-top: 6px; }
    .skillCreateSummary { height: 25px; border: 1px solid #2563eb; border-radius: 7px; padding: 0 8px; background: #2563eb; color: #fff; font-size: 10px; font-weight: 650; cursor: pointer; }
    .skillTransfer { height: 25px; border: 1px solid #cbd5e1; border-radius: 7px; padding: 0 8px; background: #fff; color: #334155; font-size: 10px; cursor: pointer; }
    .skillPagesLabel { margin-top: 8px; color: #64748b; font-size: 10px; }
    .skillPagesWrap { margin-top: 7px; }
    .skillPagesWrap.collapsed { max-height: 60px; overflow: hidden; }
    .skillCurrentLabel { display: flex; align-items: center; gap: 7px; padding: 11px; border-bottom: 1px solid rgba(0,0,0,.07); background: #fff; color: #334155; font-size: 13px; font-weight: 700; line-height: 1.5; }
    .skillCurrentLabelText { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .skillRename { border: 0; padding: 0 3px; background: transparent; color: #2563eb; font-size: 10px; cursor: pointer; vertical-align: baseline; }
    .skillToggleList { height: 26px; border: 1px solid #bfdbfe; border-radius: 7px; padding: 0 9px; background: #eff6ff; color: #1d4ed8; font-size: 10px; font-weight: 700; cursor: pointer; }
    .skillList .skillCard { margin: 0; border: 0; border-radius: 0; }
    .skillList .skillCard + .skillCard { border-top: 1px solid rgba(0,0,0,.07); }
    .skillPages { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
    .skillPageLink { max-width: 100%; height: 27px; border: 1px solid #bfdbfe; border-radius: 8px; padding: 0 8px; background: #eff6ff; color: #1d4ed8; font-size: 10px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .skillPageName { color: #1d4ed8; }
    .skillPageCount { margin: 0 2px; color: #dc2626; font-weight: 750; }
    .skillPageNumbers { color: #b91c1c; font-size: 9px; font-weight: 700; }
    .skillMethodTitle { margin-top: 13px; padding-top: 11px; border-top: 1px solid rgba(0,0,0,.07); color: #1e3a8a; font-size: 12px; font-weight: 650; }
    .skillSourceBlock { margin-top: 12px; padding: 10px; border: 1px solid rgba(59,130,246,.2); border-radius: 10px; background: #f8fbff; }
    .skillBlockTitle { margin-bottom: 8px; color: #1e3a8a; font-size: 12px; font-weight: 650; }
    .skillSourceBlock .skillField { margin-top: 0; }
    .skillSourceBlock .skillSource { background: #fff; }
    .skillSourceList { display: grid; gap: 7px; }
    .skillSourceItem { padding: 8px; border: 1px solid #dbeafe; border-radius: 8px; background: #fff; }
    .skillSourceItemHead { display: flex; align-items: center; gap: 7px; }
    .skillSourceItemName { flex: 1; min-width: 0; color: #1e293b; font-size: 11px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .skillSourceNameInput { flex: 1; min-width: 0; height: 29px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 7px; padding: 0 8px; background: #fff; color: #1e293b; font-size: 11px; font-weight: 650; outline: none; }
    .skillSourceNameInput:focus { border-color: #60a5fa; box-shadow: 0 0 0 2px rgba(59,130,246,.12); }
    .skillSourceItemMeta { margin-top: 4px; color: #64748b; font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
    .skillSourceItemActions { display: flex; gap: 6px; margin-top: 7px; }
    .skillReuseBlock { margin-top: 10px; padding: 10px; border: 1px dashed #bfdbfe; border-radius: 10px; background: #fff; }
    .skillReuseTitle { color: #1d4ed8; font-size: 11px; font-weight: 700; }
    .skillReuseHint { margin-top: 4px; color: #64748b; font-size: 10px; line-height: 1.5; }
    .skillReuseList { display: grid; gap: 7px; margin-top: 8px; }
    .skillReuseItem {
      padding: 8px;
      border: 1px solid #dbeafe;
      border-radius: 10px;
      background: linear-gradient(180deg, #f8fbff 0%, #eef6ff 100%);
      box-shadow: 0 6px 16px rgba(148, 163, 184, 0.08);
      transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
    }
    .skillReuseItem:not(.unavailable):hover {
      border-color: #93c5fd;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.14);
      transform: translateY(-1px);
    }
    .skillReuseItem.unavailable { opacity: 0.68; }
    .skillReuseHead { display: flex; align-items: center; gap: 6px; }
    .skillReuseName { flex: 1; min-width: 0; color: #1e293b; font-size: 11px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .skillReuseAction {
      height: 30px;
      padding: 0 14px;
      border: 1px solid #1d4ed8;
      border-radius: 999px;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 55%, #1d4ed8 100%);
      box-shadow: 0 8px 18px rgba(37, 99, 235, 0.24);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .2px;
      transition: transform .18s ease, box-shadow .18s ease, filter .18s ease;
    }
    .skillReuseAction:hover:not(:disabled) {
      filter: brightness(1.04);
      transform: translateY(-1px) scale(1.01);
      box-shadow: 0 12px 24px rgba(37, 99, 235, 0.32);
    }
    .skillReuseAction:disabled {
      border-color: #cbd5e1;
      background: #e2e8f0;
      box-shadow: none;
      color: #94a3b8;
    }
    .skillTextarea { width: 100%; height: 132px; min-height: 100px; box-sizing: border-box; resize: vertical; flex: none; border: 1px solid rgba(0,0,0,.14); border-radius: 8px; padding: 9px 10px; background: #fff; color: #111827; font-size: 12px; line-height: 1.55; }
    .skillMethodState { display: inline-block; margin-top: 6px; padding: 2px 6px; border-radius: 999px; font-size: 10px; }
    .skillMethodState.ready { color: #166534; background: #dcfce7; }
    .skillMethodState.empty { display: inline-flex; align-items: center; gap: 5px; color: #b91c1c; background: #fee2e2; }
    .skillMethodState.empty::before { content: "!"; display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 50%; font-size: 9px; font-weight: 750; line-height: 1; }
    ${SKILL_WORKSPACE_CSS}

    .backdrop { position: fixed; inset: 0; background: transparent; pointer-events: none; }
  `;

async function exportAllSkills() {
  try {
    const count = await downloadSkillsExport();
    showToast(`已导出 ${count} 个技能`);
  } catch (error) {
    showToast(`导出失败：${String(error?.message ?? error)}`);
  }
}

function chooseSkillImportFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      input.remove();
      resolve(file);
    }, { once: true });
    document.documentElement.appendChild(input);
    input.click();
  });
}

async function importAllSkills() {
  try {
    const file = await chooseSkillImportFile();
    if (!file) return;
    const preview = await previewSkillsImport(await file.text());
    if (!preview.success) {
      setOpen(true);
      showToast(`导入完成：0 个成功导入，${preview.duplicate} 个重复未导入，${preview.failed} 个导入失败`, 5000, { position: "center" });
      return;
    }
    const accepted = await showConfirmDialog(
      `文件中共 ${preview.total} 个技能：${preview.success} 个可导入，${preview.duplicate} 个重复不导入，${preview.failed} 个格式错误。是否继续？`,
      { confirmText: "确认导入", cancelText: "取消" }
    );
    if (!accepted) return;
    const result = await applySkillsImport(preview);
    setOpen(true);
    showToast(`导入完成：${result.success} 个成功导入，${result.duplicate} 个重复未导入，${result.failed} 个导入失败`, 5000, { position: "center" });
  } catch (error) {
    setOpen(true);
    showToast(`导入失败：${String(error?.message ?? error)}`, 4000, { position: "center" });
  }
}

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
          lastBubble.classList.remove("waiting");
          lastBubble.innerHTML = renderMarkdown(refs.streamingMsgRef.content);
          chatList.scrollTop = chatList.scrollHeight;
          return;
        }
      }
    }
    render();
  });
}

function selectScreenshotRegion() {
  return new Promise((resolve) => {
    const selector = el("div", {
      id: "web2ai_screenshot_selector",
      "data-web2ai-ui": true,
      style: { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair", background: "rgba(15,23,42,.18)", userSelect: "none" }
    });
    const hint = el("div", {
      style: { position: "fixed", left: "50%", top: "18px", transform: "translateX(-50%)", padding: "8px 14px", borderRadius: "999px", background: "rgba(17,24,39,.92)", color: "#fff", fontSize: "13px", pointerEvents: "none" }
    }, ["拖拽选择截图区域 · Esc 取消"]);
    const box = el("div", {
      style: { position: "fixed", display: "none", border: "2px solid #3b82f6", background: "rgba(59,130,246,.12)", boxShadow: "0 0 0 9999px rgba(15,23,42,.28)", pointerEvents: "none" }
    });
    selector.append(hint, box);
    let start = null;
    const cleanup = (value) => {
      document.removeEventListener("keydown", onKeyDown, true);
      selector.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    };
    selector.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY };
      box.style.display = "block";
      selector.setPointerCapture(event.pointerId);
    });
    selector.addEventListener("pointermove", (event) => {
      if (!start) return;
      const left = Math.min(start.x, event.clientX);
      const top = Math.min(start.y, event.clientY);
      Object.assign(box.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${Math.abs(event.clientX - start.x)}px`, height: `${Math.abs(event.clientY - start.y)}px`
      });
    });
    selector.addEventListener("pointerup", (event) => {
      if (!start) return;
      const rect = {
        left: Math.min(start.x, event.clientX),
        top: Math.min(start.y, event.clientY),
        width: Math.abs(event.clientX - start.x),
        height: Math.abs(event.clientY - start.y)
      };
      cleanup(rect.width >= 10 && rect.height >= 10 ? rect : null);
    });
    document.addEventListener("keydown", onKeyDown, true);
    document.documentElement.appendChild(selector);
  });
}

async function cropScreenshot(dataUrl, rect) {
  if (!rect) return dataUrl;
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scaleX = image.naturalWidth / window.innerWidth;
  const scaleY = image.naturalHeight / window.innerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scaleX));
  canvas.height = Math.max(1, Math.round(rect.height * scaleY));
  canvas.getContext("2d").drawImage(
    image,
    Math.round(rect.left * scaleX), Math.round(rect.top * scaleY), canvas.width, canvas.height,
    0, 0, canvas.width, canvas.height
  );
  return canvas.toDataURL("image/jpeg", 0.82);
}

const nextAnimationFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function isInViewport(element) {
  const rect = element?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
}

/**
 * 滚动后等待页面达到“软稳定”：至少完成两帧绘制、DOM 连续 150ms 无变化，
 * 且视口图片和常见加载态已经完成。实时页面最多等待 1.5 秒，避免永久阻塞。
 */
async function waitForViewportStable({ minWait = 100, quietMs = 150, timeoutMs = 1500 } = {}) {
  const startedAt = performance.now();
  let lastMutationAt = startedAt;
  const observer = new MutationObserver(() => { lastMutationAt = performance.now(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    await nextAnimationFrame();
    await nextAnimationFrame();
    while (performance.now() - startedAt < timeoutMs) {
      const now = performance.now();
      const imagesReady = Array.from(document.images).every((image) =>
        !isInViewport(image) || (image.complete && image.naturalWidth > 0)
      );
      const loadingVisible = Array.from(document.querySelectorAll(
        '[aria-busy="true"], .skeleton, [class*="skeleton" i], [class*="loading" i], [class*="spinner" i]'
      )).some(isInViewport);
      if (now - startedAt >= minWait && now - lastMutationAt >= quietMs && imagesReady && !loadingVisible) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  } finally {
    observer.disconnect();
  }
}

function getCapturePluginNodes() {
  return [
    refs.overlayHost,
    refs.launcherFab,
    refs.launcherBadge,
    refs.batchBar,
    refs.tableRowFab,
    refs.inlineRowFab,
    document.getElementById("web2ai_toast"),
    ...refs.pinnedRowOverlays.values()
  ].filter(Boolean);
}

function createMultiScreenProgress() {
  const node = el("div", {
    id: "web2ai_multi_capture_progress",
    "data-web2ai-ui": true,
    style: {
      position: "fixed",
      left: "50%",
      top: "24px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      display: "none",
      padding: "10px 16px",
      borderRadius: "999px",
      background: "rgba(17,24,39,.94)",
      color: "#fff",
      fontSize: "13px",
      fontWeight: "600",
      boxShadow: "0 10px 30px rgba(0,0,0,.25)",
      pointerEvents: "none",
      whiteSpace: "nowrap"
    }
  });
  document.documentElement.appendChild(node);
  return node;
}

/**
 * 找到承载主要页面内容的纵向滚动目标。后台系统常把 body 固定，并在 main/div
 * 中滚动；仅检查 window 会误判已经到达页面底部。
 */
function getPrimaryScrollTarget() {
  const root = document.scrollingElement || document.documentElement;
  const rootRange = Math.max(0, root.scrollHeight - innerHeight);
  let best = null;
  let bestLabel = "";
  let bestScore = 0;
  for (const element of document.querySelectorAll("body *")) {
    if (element.closest?.("[data-web2ai-ui], #web2ai_overlay_host")) continue;
    const range = element.scrollHeight - element.clientHeight;
    if (range <= 20 || element.clientHeight < 120 || element.clientWidth < innerWidth * 0.25) continue;
    const style = getComputedStyle(element);
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const visibleHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    if (visibleHeight < 120) continue;
    const score = visibleWidth * visibleHeight * Math.log2(range + 2);
    if (score > bestScore) {
      best = element;
      bestLabel = `${element.tagName.toLowerCase()}#${element.id || ""}.${String(element.className || "").split(/\s+/).slice(0, 2).join(".")}`;
      bestScore = score;
    }
  }

  const rootScore = rootRange > 20 ? innerWidth * innerHeight * Math.log2(rootRange + 2) : 0;
  if (rootScore >= bestScore) best = null;

  if (best) {
    return {
      element: best,
      kind: "element",
      label: bestLabel || "element",
      get x() { return best.scrollLeft; },
      get y() { return best.scrollTop; },
      get maxY() { return Math.max(0, best.scrollHeight - best.clientHeight); },
      get viewportHeight() { return best.clientHeight; },
      scrollTo(x, y) { best.scrollTo(x, y); }
    };
  }

  return {
    element: root,
    kind: "window",
    label: "window",
    get x() { return scrollX; },
    get y() { return scrollY; },
    get maxY() { return Math.max(0, root.scrollHeight - innerHeight); },
    get viewportHeight() { return innerHeight; },
    scrollTo(x, y) { window.scrollTo(x, y); }
  };
}

let frameMultiScreenScrollTarget = null;

function inspectMultiScreenScrollTarget() {
  frameMultiScreenScrollTarget = getPrimaryScrollTarget();
  return {
    kind: frameMultiScreenScrollTarget.kind,
    label: frameMultiScreenScrollTarget.label,
    x: frameMultiScreenScrollTarget.x,
    y: frameMultiScreenScrollTarget.y,
    maxY: frameMultiScreenScrollTarget.maxY,
    viewportHeight: frameMultiScreenScrollTarget.viewportHeight,
    score: frameMultiScreenScrollTarget.maxY * frameMultiScreenScrollTarget.viewportHeight
  };
}

async function setMultiScreenScrollPosition({ x, y } = {}) {
  if (!frameMultiScreenScrollTarget) frameMultiScreenScrollTarget = getPrimaryScrollTarget();
  frameMultiScreenScrollTarget.element.style.scrollBehavior = "auto";
  frameMultiScreenScrollTarget.scrollTo(Number(x) || 0, Number(y) || 0);
  await nextAnimationFrame();
  await nextAnimationFrame();
  return {
    x: frameMultiScreenScrollTarget.x,
    y: frameMultiScreenScrollTarget.y,
    maxY: frameMultiScreenScrollTarget.maxY,
    viewportHeight: frameMultiScreenScrollTarget.viewportHeight
  };
}

async function restoreMultiScreenScrollPosition({ x, y, scrollBehavior = "" } = {}) {
  if (!frameMultiScreenScrollTarget) return { ok: true };
  frameMultiScreenScrollTarget.scrollTo(Number(x) || 0, Number(y) || 0);
  frameMultiScreenScrollTarget.element.style.scrollBehavior = scrollBehavior;
  await nextAnimationFrame();
  frameMultiScreenScrollTarget = null;
  return { ok: true };
}

async function captureScreenshot({ selectRegion = false } = {}) {
  if (STATE.pending) return;
  let screenshotAdded = false;
  const pluginNodes = getCapturePluginNodes();
  const previousVisibility = pluginNodes.map((node) => [node, node.style.visibility]);
  const selectedRows = Array.from(document.querySelectorAll('[data-web2ai-selected="1"]'));
  try {
    // captureVisibleTab 会捕获注入页面的扩展 UI；截图前隐藏插件自身，避免把 Chat、
    // checkbox 和选中高亮一并作为视觉上下文发送给模型。
    for (const node of pluginNodes) node.style.visibility = "hidden";
    for (const row of selectedRows) delete row.dataset.web2aiSelected;
    const region = selectRegion ? await selectScreenshotRegion() : null;
    if (selectRegion && !region) {
      showToast("已取消区域截图");
      return;
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const response = await sendToBackground({ type: "CAPTURE_VISIBLE_TAB" });
    const dataUrl = response?.data?.dataUrl ? await cropScreenshot(response.data.dataUrl, region) : "";
    if (!response?.ok || !dataUrl) throw new Error(response?.error || "截图失败");
    addContextSnippet({
      kind: "screenshot",
      text: `${selectRegion ? "用户选择区域截图" : "当前页面可见区域截图"} · ${new Date(response.data.capturedAt || Date.now()).toLocaleString()}`,
      imageData: dataUrl,
      imageMimeType: "image/jpeg",
      url: location.href,
      title: document.title
    });
    screenshotAdded = true;
    showToast("截图已加入上下文");
  } catch (error) {
    showToast(`截图失败：${String(error?.message ?? error)}`, 2800);
  } finally {
    // 捕获失败时也必须恢复页面交互。
    for (const [node, visibility] of previousVisibility) node.style.visibility = visibility;
    for (const row of selectedRows) row.dataset.web2aiSelected = "1";
  }
  if (screenshotAdded) await offerImageCapableModelSwitch();
}

let multiScreenCaptureActive = false;

/** 从当前位置开始逐屏向下截图；每一屏作为独立图片上下文，不做拼接。 */
async function captureMultipleScreens({ maxScreens = 5 } = {}) {
  if (STATE.pending || multiScreenCaptureActive) return;
  multiScreenCaptureActive = true;
  const targetResponse = await sendToBackground({ type: "FIND_MULTI_SCREEN_SCROLL_TARGET" }).catch(() => null);
  const remoteTarget = targetResponse?.ok ? targetResponse.data : null;
  const localScrollTarget = !remoteTarget || remoteTarget.frameId === 0 ? getPrimaryScrollTarget() : null;
  const scrollTarget = localScrollTarget || {
    kind: remoteTarget.kind,
    label: `frame:${remoteTarget.frameId}/${remoteTarget.label}`,
    frameId: remoteTarget.frameId,
    x: remoteTarget.x,
    y: remoteTarget.y,
    maxY: remoteTarget.maxY,
    viewportHeight: remoteTarget.viewportHeight,
    element: null
  };
  const originalScroll = { x: scrollTarget.x, y: scrollTarget.y };
  const originalScrollBehavior = scrollTarget.element?.style.scrollBehavior || "";
  const pluginNodes = getCapturePluginNodes();
  const previousVisibility = pluginNodes.map((node) => [node, node.style.visibility]);
  const selectedRows = Array.from(document.querySelectorAll('[data-web2ai-selected="1"]'));
  const progress = createMultiScreenProgress();
  const captures = [];
  let lastCapturedAt = 0;
  try {
    for (const node of pluginNodes) node.style.visibility = "hidden";
    for (const row of selectedRows) delete row.dataset.web2aiSelected;
    if (scrollTarget.element) scrollTarget.element.style.scrollBehavior = "auto";

    for (let index = 0; index < maxScreens; index++) {
      await waitForViewportStable();
      // captureVisibleTab 有调用频率限制；稳定较快时补足截图间隔。
      const pacingWait = Math.max(0, 550 - (performance.now() - lastCapturedAt));
      if (lastCapturedAt && pacingWait) await new Promise((resolve) => setTimeout(resolve, pacingWait));
      // 提示只在两次截图之间显示，实际截图前隐藏，避免进入图片内容。
      progress.style.display = "none";
      await nextAnimationFrame();
      await nextAnimationFrame();
      const response = await sendToBackground({ type: "CAPTURE_VISIBLE_TAB" });
      const dataUrl = response?.data?.dataUrl || "";
      if (!response?.ok || !dataUrl) throw new Error(response?.error || "截图失败");
      lastCapturedAt = performance.now();
      captures.push({ dataUrl, capturedAt: response.data.capturedAt || Date.now(), scrollY: scrollTarget.y });
      progress.textContent = `已完成 ${index + 1}/${maxScreens}，正在继续截图…`;
      progress.style.display = "block";
      await new Promise((resolve) => setTimeout(resolve, 200));
      progress.style.display = "none";

      const currentY = scrollTarget.y;
      const maxScrollY = scrollTarget.maxY;
      if (currentY >= maxScrollY - 2) {
        break;
      }
      const nextY = Math.min(maxScrollY, currentY + Math.max(1, Math.floor(scrollTarget.viewportHeight * 0.9)));
      if (nextY <= currentY) {
        break;
      }
      if (scrollTarget.frameId != null) {
        const result = await sendToBackground({
          type: "SET_MULTI_SCREEN_SCROLL_POSITION",
          frameId: scrollTarget.frameId,
          x: scrollTarget.x,
          y: nextY
        });
        if (!result?.ok) throw new Error(result?.error || "无法滚动目标页面");
        Object.assign(scrollTarget, result.data || {});
      } else {
        scrollTarget.scrollTo(scrollTarget.x, nextY);
        await nextAnimationFrame();
        await nextAnimationFrame();
      }
    }

    // contexts 为 newest-first；逆序加入后，卡片仍按页面从上到下排列。
    for (let index = captures.length - 1; index >= 0; index--) {
      const capture = captures[index];
      addContextSnippet({
        kind: "screenshot",
        text: `多屏截图 ${index + 1}/${captures.length} · 页面位置 ${Math.round(capture.scrollY)}px · ${new Date(capture.capturedAt).toLocaleString()}`,
        imageData: capture.dataUrl,
        imageMimeType: "image/jpeg",
        url: location.href,
        title: document.title,
        silent: true
      });
    }
    if (captures.length) {
      render();
      progress.textContent = `多屏截图完成，共 ${captures.length} 张`;
      progress.style.display = "block";
      await new Promise((resolve) => setTimeout(resolve, 500));
      showToast(`已将 ${captures.length} 张多屏截图加入上下文`);
    }
  } catch (error) {
    showToast(`多屏截图失败：${String(error?.message ?? error)}`, 3000);
  } finally {
    if (scrollTarget.frameId != null) {
      await sendToBackground({
        type: "RESTORE_MULTI_SCREEN_SCROLL_POSITION",
        frameId: scrollTarget.frameId,
        x: originalScroll.x,
        y: originalScroll.y,
        scrollBehavior: originalScrollBehavior
      }).catch(() => void 0);
    } else {
      scrollTarget.scrollTo(originalScroll.x, originalScroll.y);
      scrollTarget.element.style.scrollBehavior = originalScrollBehavior;
    }
    for (const [node, visibility] of previousVisibility) node.style.visibility = visibility;
    for (const row of selectedRows) row.dataset.web2aiSelected = "1";
    progress.remove();
    multiScreenCaptureActive = false;
  }
  if (captures.length) await offerImageCapableModelSwitch();
}

async function refreshModelOptions({ shouldRender = true } = {}) {
  const response = await sendToBackground({ type: "GET_SETTINGS" });
  if (!response?.ok || !response.data) return;
  STATE.modelOptions = Array.isArray(response.data.models) ? response.data.models : [];
  const currentStillExists = STATE.modelOptions.some((profile) => profile.id === STATE.activeModelId);
  if (!currentStillExists) {
    STATE.activeModelId = response.data.defaultModelId || response.data.activeModelId || STATE.modelOptions[0]?.id || "";
  }
  if (shouldRender) render();
}

/**
 * 截图加入上下文后，确保用户有机会切换到可接收图片的模型。
 * 仅在当前模型不支持图片且存在可用图片模型时询问，避免无效提示。
 */
async function offerImageCapableModelSwitch() {
  const response = await sendToBackground({ type: "GET_SETTINGS" });
  if (!response?.ok || !response.data) return;
  const currentModel = (response.data.models || []).find((profile) => profile.id === STATE.activeModelId);
  if (currentModel?.supportsImages) return;
  const imageModel = (response.data.models || []).find((profile) => profile.supportsImages);
  if (!imageModel) return;
  const currentName = currentModel?.name || currentModel?.model || "当前模型";
  const imageModelName = imageModel.name || imageModel.model || "支持图片的模型";
  const accepted = await showConfirmDialog(
    `当前模型“${currentName}”不支持图片，是否切换到支持图片的模型“${imageModelName}”？`
  );
  if (!accepted) return;
  const switchResponse = await sendToBackground({ type: "SET_ACTIVE_MODEL", modelId: imageModel.id });
  if (!switchResponse?.ok) {
    showToast(`切换模型失败：${switchResponse?.error || "未知错误"}`, 2800);
    return;
  }
  STATE.activeModelId = imageModel.id;
  await refreshModelOptions();
  showToast(`已切换到“${imageModelName}”`);
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
  const previousSkillsPanel = refs.overlayShadow?.getElementById?.("web2ai_skills_body");
  if (previousSkillsPanel && STATE.activePanelTab === "skills") {
    STATE.skillsPanelScrollTop = previousSkillsPanel.scrollTop || 0;
  }
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
  const isMaximized = STATE.open && (STATE.maximized || STATE.skillTest);
  const floatingZIndex = isMaximized ? "1" : Z_INDEX;
  const tableUiZIndex = isMaximized ? "1" : TABLE_UI_Z_INDEX;
  if (refs.launcherFab) refs.launcherFab.style.zIndex = floatingZIndex;
  if (refs.batchBar) refs.batchBar.style.zIndex = tableUiZIndex;
  if (refs.tableRowFab) refs.tableRowFab.style.zIndex = tableUiZIndex;
  // 内联 checkbox 属于单元格局部 UI；抬到全局 999 会压住站点菜单。
  if (refs.inlineRowFab) refs.inlineRowFab.style.zIndex = isMaximized ? "1" : "3";
  for (const node of refs.pinnedRowOverlays.values()) {
    // 表格内联标记保持局部层级，不能在每次 render 时重新抬到全局 999，
    // 否则会覆盖站点挂载到 body 的 Dropdown/Popover。
    node.style.zIndex = isMaximized
      ? "1"
      : node.dataset.web2aiInline === "1" ? "3" : TABLE_UI_Z_INDEX;
  }

  const wrap = el("div", {
    class: `wrap ${STATE.open ? "" : "hidden"}${STATE.maximized || STATE.skillTest ? " max" : ""}`
  });
  const backdrop = el("div", {
    class: `backdrop ${STATE.open ? "" : "hidden"}`
  });

  const modelSelect = el("select", {
    id: "web2ai_model_select",
    title: "切换当前对话模型",
    style: { width: "150px", height: "28px", borderRadius: "10px", border: "1px solid rgba(59,130,246,.45)", background: "#eff6ff", color: "#1e3a8a", padding: "0 8px", fontSize: "12px", fontWeight: "650" },
    onChange: async (event) => {
      const previous = STATE.activeModelId;
      STATE.activeModelId = event.target.value;
      const response = await sendToBackground({ type: "SET_ACTIVE_MODEL", modelId: STATE.activeModelId });
      if (!response?.ok) {
        STATE.activeModelId = previous;
        showToast(`切换模型失败：${response?.error || "未知错误"}`);
      }
      await refreshModelOptions();
    }
  }, STATE.modelOptions.map((profile) => el("option", {
    value: profile.id,
    selected: profile.id === STATE.activeModelId ? true : null
  }, [profile.name || profile.model])));
  const activeModel = STATE.modelOptions.find((profile) => profile.id === STATE.activeModelId) || STATE.modelOptions[0] || null;
  const modelConfigReady = Boolean(activeModel?.hasApiKey);
  const analysisModelControl = modelConfigReady
    ? el("div", { class: "skillAnalysisModel", title: "可切换本次技能使用的模型" }, [
        el("span", {}, ["当前模型："]),
        modelSelect,
        el("span", { class: "skillAnalysisModelHint" }, ["（支持切换）"])
      ])
    : el("div", { class: "skillAnalysisModel missing", title: "当前模型尚未完成配置" }, [
        el("span", {}, [`当前模型：${activeModel?.name || activeModel?.model || "未配置"}`]),
        el("span", { class: "skillAnalysisModelHint warning" }, [activeModel ? "未配置密钥" : "尚未配置模型"]),
        el("button", {
          class: "btn primary skillAnalysisModelAction",
          onClick: () => openOptionsPage()
        }, ["去配置模型"])
      ]);
  const imageCapabilityTip = el("span", {
    title: activeModel?.supportsImages
      ? "当前模型配置允许发送截图"
      : "当前模型配置不允许发送截图",
    style: {
      padding: "3px 7px",
      borderRadius: "999px",
      whiteSpace: "nowrap",
      fontSize: "10px",
      fontWeight: "650",
      color: activeModel?.supportsImages ? "#166534" : "#6b7280",
      background: activeModel?.supportsImages ? "#dcfce7" : "#f3f4f6",
      border: activeModel?.supportsImages ? "1px solid #bbf7d0" : "1px solid #e5e7eb"
    }
  }, [activeModel?.supportsImages ? "支持图片" : "不支持图片"]);


  const header = el("div", { class: "header" }, [
    el("div", { class: "headerRow" }, [
      el("div", { style: { flex: "1" } }),
      STATE.activePanelTab === "chat" ? modelSelect : null,
      STATE.activePanelTab === "chat" ? imageCapabilityTip : null,
      el("button", {
        class: "btn",
        title: STATE.maximized ? "还原窗口" : "最大化",
        "aria-label": STATE.maximized ? "还原窗口" : "最大化",
        style: { width: "30px", padding: "0", fontSize: "16px" },
        onClick: () => toggleMaximized()
      }, [STATE.maximized ? "▣" : "⛶"]),
      el("button", {
        class: "btn",
        title: "设置",
        "aria-label": "设置",
        style: { width: "30px", padding: "0", fontSize: "16px" },
        onClick: () => openOptionsPage()
      }, ["⚙"]),
      el("button", {
        class: "btn",
        title: "关闭",
        "aria-label": "关闭",
        style: { width: "28px", padding: "0", fontSize: "16px", lineHeight: "26px" },
        onClick: () => setOpen(false)
      }, ["\u00d7"])
    ])
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
    const isScreenshot = c.kind === "screenshot" && c.imageData;
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
            : c.kind === "table-row" ? "表格内容" : c.kind === "screenshot" ? "截图" : c.kind
        ]),
        `${c.lineInfo?.startLine && c.lineInfo?.endLine
            ? ` · L${c.lineInfo.startLine}-${c.lineInfo.endLine}`
            : ""
        } · ${new Date(c.createdAt).toLocaleString()}`
      ]),
      isScreenshot
        ? el("img", { class: "contextScreenshot", src: c.imageData, alt: c.text || "网页截图" })
        : el("div", { class: "contextText", title: tipText }, [shownText]),
      !isScreenshot && omittedHint ? el("div", { class: "contextOmitted" }, [omittedHint]) : null,
      null
    ]);
  }

  function renderContexts() {
    const groups = STATE.tableGroups;
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
    for (const screenshot of STATE.contexts.filter((context) => context.kind === "screenshot")) {
      els.push(renderContextItem(screenshot));
    }
    if (!els.length) {
      return [el("div", { style: { fontSize: "12px", color: "#6b7280" } }, ["还没有上下文，可勾选表格行或点击“截图”。"])];
    }
    return els;
  }

  const tableCount = STATE.tableGroups.length;
  const rowCount = STATE.tableGroups.reduce((sum, g) => sum + g.rows.length, 0);
  const screenshotCount = STATE.contexts.filter((context) => context.kind === "screenshot").length;
  const contextSection = el("div", { class: "section contextSec" }, [
    el("div", { class: "sectionHead" }, [
      el("div", { class: "sectionTitle" }, [`上下文（${tableCount} 个表格，共 ${rowCount} 条；${screenshotCount} 张截图）`]),
      el("label", {
        class: "tableAskToggle",
        title: "关闭后，页面表格行上不再显示“问AI”入口"
      }, [
        el("span", {}, ["页面问AI"]),
        el("input", {
          id: "web2ai_table_ask_toggle",
          type: "checkbox",
          role: "switch",
          checked: STATE.tableAskAiEnabled ? true : null,
          "aria-label": "显示页面问AI入口",
          "aria-checked": STATE.tableAskAiEnabled ? "true" : "false",
          onChange: (event) => {
            const enabled = Boolean(event.target.checked);
            setTableAskAiEnabled(enabled);
            chrome.storage.sync.set({ tableAskAiEnabled: enabled }).catch(() => void 0);
            render();
          }
        })
      ]),
      el("button", {
        class: "btn danger",
        disabled: STATE.pending || STATE.contexts.length === 0 ? true : null,
        title: "清空所有表格和截图上下文",
        onClick: () => clearContext()
      }, ["清空上下文"]),
      el("button", {
        class: "btn",
        disabled: STATE.pending ? true : null,
        title: "拖拽选择当前可见区域",
        onClick: () => captureScreenshot({ selectRegion: true })
      }, ["截图"]),
      el("button", {
        class: "btn",
        disabled: STATE.pending || multiScreenCaptureActive ? true : null,
        title: "从当前位置向下截取最多 5 个页面视口",
        onClick: () => captureMultipleScreens({ maxScreens: 5 })
      }, ["多屏截图"])
    ]),
    el("div", { class: "sectionBody" }, renderContexts())
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
            const isWaiting = m.role === "assistant" && STATE.pending && !normalizeText(m.content);
            const bubble = el("div", { class: `bubble ${m.role}${isWaiting ? " waiting" : ""}` });
            if (m.role === "assistant") {
              if (isWaiting) {
                bubble.append(
                  el("span", {}, ["正在等待模型回复"]),
                  el("span", { class: "waitingDots", "aria-label": "加载中" }, [el("i"), el("i"), el("i")])
                );
              } else bubble.innerHTML = renderMarkdown(m.content);
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
      el("div", { class: "composerMain" }, [
        el("textarea", {
          id: "web2ai_input",
          placeholder: "问点什么…（Enter 发送，Shift+Enter 换行）"
        })
      ]),
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
        ),
        el(
          "button",
          {
            class: "btn danger",
            disabled: STATE.pending ? true : null,
            onClick: () => clearAll()
          },
          ["清空全部"]
        )
      ])
    ])
  ]);

  const body = el("div", { class: `body${STATE.maximized ? " max" : ""}` }, [
    contextSection,
    chatSection
  ]);
  function renderSkillsPanel() {
    const draft = STATE.skillDraft;
    const currentPageKey = (() => {
      try { const url = new URL(location.href); return `${url.origin}${url.pathname}`; } catch { return location.href; }
    })();
    const pageGroups = new Map();
    // 序号基于“全部技能”的统一顺序生成；当前页筛选和页面切换只引用这张
    // 映射，不会在每个页面重新从 1 编号。
    const skillNumberById = new Map(STATE.skillCatalog.map((skill, index) => [skill.id, index + 1]));
    for (const skill of STATE.skillCatalog) {
      const relatedPages = new Map();
      relatedPages.set(skill.pageKey, {
        pageKey: skill.pageKey,
        pageUrl: skill.pageUrl,
        pageTitle: skill.pageTitle,
        source: (skill.sources || []).find((source) => source.pageKey === skill.pageKey) || skill.source || null
      });
      for (const source of skill.sources || [skill.source].filter(Boolean)) {
        if (!source.pageKey) continue;
        relatedPages.set(source.pageKey, {
          pageKey: source.pageKey,
          pageUrl: source.pageUrl,
          pageTitle: source.pageTitle,
          source
        });
      }
      for (const page of relatedPages.values()) {
        if (!page.pageKey) continue;
        const group = pageGroups.get(page.pageKey) || {
          ...page,
          count: 0,
          skills: [],
          label: STATE.skillPageNames[page.pageKey] || page.pageTitle || page.pageKey
        };
        group.count++;
        group.skills.push(skill);
        if (!group.source && page.source) group.source = page.source;
        pageGroups.set(page.pageKey, group);
      }
    }
    const otherPages = [...pageGroups.values()].filter((group) => group.pageKey !== currentPageKey);
    const currentPageName = STATE.skillPageNames[currentPageKey] || STATE.skills[0]?.pageTitle || document.title || currentPageKey;
    if (!otherPages.length) {
      STATE.skillCatalogExpanded = false;
      STATE.skillCatalogCanToggle = false;
    }
    if (draft) draft.analysisMethod = { description: buildAnalysisPrompt(draft.analysisMethod) };
    const draftType = draft ? skillTypeOf(draft) : SKILL_TYPE_TABLE_ANALYSIS;
    const setDraftType = (nextType) => {
      if (!draft || nextType === draftType) return;
      if (nextType === SKILL_TYPE_DERIVED_COLUMN) {
        const normalized = normalizeDerivedColumnSkill({
          ...draft,
          type: nextType,
          sources: draft.sources.slice(0, 1),
          selectedColumns: normalizeDerivedColumnSelections(draft.selectedColumns),
          output: normalizeDerivedColumnOutput(draft.output),
          defaultMethodVersion: draft.defaultMethodVersion || DEFAULT_DERIVED_METHOD_VERSION
        });
        draft.type = nextType;
        draft.sources = draft.sources.slice(0, 1);
        draft.selectedColumns = normalized.selectedColumns;
        draft.output = normalized.output;
        draft.trigger = normalized.trigger;
        draft.execution = normalized.execution;
        draft.defaultMethodVersion = normalized.defaultMethodVersion;
      } else {
        draft.type = SKILL_TYPE_TABLE_ANALYSIS;
        draft.sources = [...(draft.sources || [])];
        delete draft.selectedColumns;
        delete draft.output;
        delete draft.trigger;
        delete draft.execution;
        delete draft.defaultMethodVersion;
      }
      render();
    };
    const toggleDerivedDraftColumn = (header, index) => {
      if (!draft) return;
      const normalizedHeader = normalizedHeaderText(header);
      if (!normalizedHeader) return;
      const headers = Array.isArray(draft.sources?.[0]?.headers) ? draft.sources[0].headers : [];
      const occurrence = headers
        .slice(0, index + 1)
        .filter((item) => normalizedHeaderText(item) === normalizedHeader)
        .length || 1;
      const key = `${normalizedHeader}#${occurrence}`;
      const selected = normalizeDerivedColumnSelections(draft.selectedColumns);
      const exists = selected.some((item) => `${item.normalizedHeader}#${item.occurrence}` === key);
      if (exists) {
        draft.selectedColumns = selected.filter((item) => `${item.normalizedHeader}#${item.occurrence}` !== key);
      } else {
        if (selected.length >= 10) {
          showToast("最多选择 10 列");
          return;
        }
        draft.selectedColumns = [...selected, {
          index,
          header,
          normalizedHeader,
          occurrence
        }].sort((left, right) => left.index - right.index);
      }
      render();
    };
    const statusLabels = {
      checking: "校验中",
      available: "可用",
      deferred: "执行时校验",
      changed: "数据源已变化",
      ambiguous: "数据源位置不明确",
      missing: "数据源失效"
    };
    const sourceStatusLabel = (detail = {}) => (
      statusLabels[detail.status || "checking"] || detail.status || "校验中"
    );
    const collectSkillUnavailableSources = (skill) => {
      const sources = skill.sources || [skill.source].filter(Boolean);
      const sourceStatuses = STATE.skillSourceStatuses[skill.id] || {};
      return sources
        .map((source, index) => ({ source, index, detail: sourceStatuses[source.id] || { status: "checking" } }))
        .filter((item) => ["missing", "ambiguous"].includes(item.detail.status));
    };
    const sourceHeaders = Array.isArray(draft?.sources?.[0]?.headers) ? draft.sources[0].headers : [];
    const selectedColumnKeys = new Set(
      normalizeDerivedColumnSelections(draft?.selectedColumns).map((column) => `${column.normalizedHeader}#${column.occurrence}`)
    );
    const buildReusableSourceKey = (source = {}) => [
      // 去重键必须兼容老绑定（无 framePathHint / locatorVersion）和新绑定，
      // 仅依赖稳定定位信息，避免同一数据源被拆成多条推荐项。
      String(source.pageKey || "").trim(),
      String(source.frameUrl || "").trim(),
      String(source.selector || "").trim(),
      Number(source.tableIndex) || 0,
      Array.isArray(source.headers) ? source.headers.map((item) => normalizedHeaderText(item || "")).join("|") : ""
    ].join("::");
    const reusableSourceStatusRank = (detail = {}) => {
      switch (detail.status) {
        case "available": return 5;
        case "deferred": return 4;
        case "changed": return 3;
        case "checking": return 2;
        case "ambiguous": return 1;
        case "missing": return 0;
        default: return 2;
      }
    };
    const cloneReusableSource = (source = {}) => ({
      ...source,
      id: uid(),
      headers: Array.isArray(source.headers) ? [...source.headers] : [],
      framePath: Array.isArray(source.framePath) ? [...source.framePath] : source.framePath,
      frameUrlChain: Array.isArray(source.frameUrlChain) ? [...source.frameUrlChain] : source.frameUrlChain
    });
    const currentDraftSourceKeys = new Set((draft?.sources || []).map((source) => buildReusableSourceKey(source)).filter(Boolean));
    const reusableSourceMap = new Map();
    for (const skill of STATE.skills) {
      const skillSources = skill.sources || [skill.source].filter(Boolean);
      const sourceStatuses = STATE.skillSourceStatuses[skill.id] || {};
      for (let index = 0; index < skillSources.length; index++) {
        const source = skillSources[index];
        if (!source || source.pageKey !== currentPageKey) continue;
        const key = buildReusableSourceKey(source);
        if (!key || reusableSourceMap.has(key) || currentDraftSourceKeys.has(key)) continue;
        const nextEntry = {
          key,
          source,
          sourceIndex: index,
          skillId: skill.id,
          skillName: skill.name,
          statusDetail: sourceStatuses[source.id] || { status: "checking" }
        };
        const existingEntry = reusableSourceMap.get(key);
        if (!existingEntry || reusableSourceStatusRank(nextEntry.statusDetail) > reusableSourceStatusRank(existingEntry.statusDetail)) {
          reusableSourceMap.set(key, nextEntry);
        }
      }
    }
    const reusableSources = [...reusableSourceMap.values()];
    const canReuseMoreSources = draftType === SKILL_TYPE_DERIVED_COLUMN
      ? (draft?.sources?.length || 0) < 1
      : (draft?.sources?.length || 0) < 5;
    const reuseExistingDraftSource = (entry) => {
      if (!draft || !entry?.source) return;
      const source = cloneReusableSource(entry.source);
      if (draftType === SKILL_TYPE_DERIVED_COLUMN) {
        draft.sources = [source];
        draft.selectedColumns = [];
      } else {
        if ((draft.sources?.length || 0) >= 5) {
          showToast("最多添加 5 个数据源");
          return;
        }
        draft.sources = [...(draft.sources || []), source];
      }
      render();
    };
    const skillTypeLocked = Boolean(draft?.id);
    const form = draft ? el("div", { class: "skillForm" }, [
      el("div", { class: "skillTitle" }, [draft.id ? "修改技能" : "创建技能"]),
      el("div", { class: "skillField" }, [
        el("span", { class: "skillFieldLabel" }, ["技能类型"]),
        el("div", { class: "skillActions" }, [
          el("button", {
            class: `btn ${draftType === SKILL_TYPE_TABLE_ANALYSIS ? "primary" : ""}`,
            disabled: skillTypeLocked,
            title: skillTypeLocked ? "修改技能时不允许切换类型" : "切换为整表分析",
            onClick: () => setDraftType(SKILL_TYPE_TABLE_ANALYSIS)
          }, ["整表分析"]),
          el("button", {
            class: `btn ${draftType === SKILL_TYPE_DERIVED_COLUMN ? "primary" : ""}`,
            disabled: skillTypeLocked,
            title: skillTypeLocked ? "修改技能时不允许切换类型" : "切换为按列分析",
            onClick: () => setDraftType(SKILL_TYPE_DERIVED_COLUMN)
          }, ["按列分析"])
        ])
      ]),
      skillTypeLocked ? el("div", { class: "skillMeta" }, ["修改技能时不允许切换技能类型。"]) : null,
      el("div", { class: "skillScenarioCard" }, [
        el("div", { class: "skillScenarioTitle" }, [draftType === SKILL_TYPE_DERIVED_COLUMN ? "按列分析适用场景" : "整表分析适用场景"]),
        el("div", { class: "skillScenarioText" }, [
          draftType === SKILL_TYPE_DERIVED_COLUMN
            ? "适合针对表格中选中的多行生成 AI 结论，例如风险识别、异常判断、优先级建议、补充标签等。正式运行时会把结果作为新列插入表格。"
            : "适合让 AI 对整张表做整体总结，例如问题归纳、趋势判断、原因分析、经营建议等。结果以整表分析结论为主，不会逐行插入结果列。"
        ])
      ]),
      el("label", { class: "skillField" }, [
        el("span", { class: "skillFieldLabel" }, ["技能名称"]),
        el("input", { class: "skillInput", value: draft.name, placeholder: "例如：异常订单分析", onInput: (event) => { draft.name = event.target.value; } })
      ]),
      el("div", { class: "skillSourceBlock" }, [
        el("div", { class: "skillBlockTitle" }, [draftType === SKILL_TYPE_DERIVED_COLUMN ? "数据源（仅支持 1 个）" : `数据源（${draft.sources.length}）`]),
        draft.sources.length ? el("div", { class: "skillSourceList" }, draft.sources.map((source, index) => el("div", { class: "skillSourceItem" }, [
          el("div", { class: "skillSourceItemHead" }, [
            el("span", { class: "skillSourceItemName", style: { flex: "0 0 auto" } }, [`${index + 1}.`]),
            el("input", {
              class: "skillSourceNameInput",
              value: source.displayName || `数据源 ${index + 1}`,
              title: "可修改数据源名称，不影响底层绑定",
              placeholder: `数据源 ${index + 1}`,
              onInput: (event) => {
                source.displayName = event.target.value;
                source.displayNameCustomized = true;
                source.displayNameOrigin = "custom";
              }
            })
          ]),
          el("div", { class: "skillSourceItemMeta" }, [
            `【${source.pageTitle || source.pageKey || "当前页面"}】· ${source.headers?.length || 0} 个字段`,
            el("br"),
            source.headers?.join("、") || "未识别到数据源字段"
          ]),
          el("div", { class: "skillSourceItemActions" }, [
            el("button", { class: "btn", onClick: () => selectSkillTable(source.id) }, ["重新选择"]),
            el("button", { class: "btn danger", onClick: () => removeSkillDraftSource(source.id) }, ["删除"])
          ])
        ]))) : el("div", { class: "skillSource" }, ["选择页面上的列表，用于后续作为大模型分析的数据来源"]),
        el("div", { class: "skillActions" }, [
          (!draft.sources.length || draftType !== SKILL_TYPE_DERIVED_COLUMN) ? el("button", {
            class: "btn",
            disabled: draftType === SKILL_TYPE_DERIVED_COLUMN ? draft.sources.length >= 1 : draft.sources.length >= 5,
            onClick: () => selectSkillTable()
          }, [draft.sources.length ? "＋ 添加数据源" : "选择数据源"]) : null,
          draftType !== SKILL_TYPE_DERIVED_COLUMN && draft.sources.length > 1
            ? el("span", { class: "skillMeta" }, [`测试和执行时将依次载入 ${draft.sources.length} 个数据源。`])
            : null
        ]),
        reusableSources.length && canReuseMoreSources ? el("div", { class: "skillReuseBlock" }, [
          el("div", { class: "skillReuseTitle" }, ["复用已有数据源"]),
          el("div", { class: "skillReuseHint" }, [
            draftType === SKILL_TYPE_DERIVED_COLUMN
              ? "当前页面已有技能绑定过的数据源如下，可直接点选 1 个复用。"
              : "当前页面已有技能绑定过的数据源如下，可按需点击某一个或多个直接复用。"
          ]),
          el("div", { class: "skillReuseList" }, reusableSources.map((entry) => {
            const detail = entry.statusDetail || { status: "checking" };
            const reusable = ["available", "deferred", "changed", "checking"].includes(detail.status);
            return el("div", {
              class: `skillReuseItem${reusable ? "" : " unavailable"}`
            }, [
              el("div", { class: "skillReuseHead" }, [
                el("span", { class: "skillReuseName" }, [entry.source.displayName || `数据源 ${entry.sourceIndex + 1}`]),
                el("span", { class: `skillStatus ${reusable ? "available" : "missing"}` }, [sourceStatusLabel(detail)])
              ]),
              el("div", { class: "skillSourceItemMeta" }, [
                `来源技能：${entry.skillName}`,
                el("br"),
                `【${entry.source.pageTitle || entry.source.pageKey || "当前页面"}】· ${entry.source.headers?.length || 0} 个字段`,
                el("br"),
                entry.source.headers?.join("、") || "未识别到数据源字段"
              ]),
              el("div", { class: "skillSourceItemActions" }, [
                el("button", {
                  class: "btn skillReuseAction",
                  disabled: reusable ? null : true,
                  onClick: () => reuseExistingDraftSource(entry)
                }, [draftType === SKILL_TYPE_DERIVED_COLUMN ? "复用这个数据源" : "复用"])
              ])
            ]);
          }))
        ]) : null
      ]),
      draftType === SKILL_TYPE_DERIVED_COLUMN ? el("div", { class: "skillSourceBlock" }, [
        el("div", { class: "skillBlockTitle" }, ["用于分析的字段"]),
        !draft.sources.length ? el("div", { class: "skillSource" }, ["请先选择数据源，再选择需要参与分析的字段。"]) : null,
        draft.sources.length && !sourceHeaders.length ? el("div", { class: "skillSource" }, ["当前数据源未识别到字段，请重新选择数据源。"]) : null,
        sourceHeaders.length ? el("div", { class: "skillSourceList" }, sourceHeaders.map((header, index) => {
          const normalized = normalizedHeaderText(header);
          const occurrence = sourceHeaders.slice(0, index + 1).filter((item) => normalizedHeaderText(item) === normalized).length || 1;
          const key = `${normalized}#${occurrence}`;
          const checked = selectedColumnKeys.has(key);
          const displayHeader = String(header || "").trim().split(/\s+/)[0] || String(header || "").trim();
          const label = sourceHeaders.filter((item) => normalizedHeaderText(item) === normalized).length > 1
            ? `${displayHeader}（第 ${index + 1} 列）`
            : displayHeader;
          return el("label", {
            class: "skillSourceItem",
            style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }
          }, [
            el("input", {
              type: "checkbox",
              checked,
              onChange: () => toggleDerivedDraftColumn(header, index)
            }),
            el("span", { class: "skillSourceItemName", style: { whiteSpace: "normal" } }, [label])
          ]);
        })) : null,
        draft.sources.length ? el("div", { class: "skillMeta" }, [`已选择 ${selectedColumnKeys.size} / 10 列。`]) : null
      ]) : null,
      el("div", { class: "skillMethodTitle" }, ["分析方法"]),
      el("label", { class: "skillField" }, [
        el("span", { class: "skillFieldLabel" }, [draftType === SKILL_TYPE_DERIVED_COLUMN ? "可选填写分析方法；留空将使用默认分析方法" : "请描述希望 AI 如何分析这个数据源"]),
        el("textarea", {
          class: "skillTextarea",
          placeholder: draftType === SKILL_TYPE_DERIVED_COLUMN
            ? "例如：识别高风险、异常、矛盾和值得关注的业务情况。留空则使用默认分析方法。"
            : "可以直接用自己的话描述。例如：帮我找出付款超过 48 小时仍未发货的订单，按风险高低列出订单号、异常原因和处理建议。",
          onInput: (event) => { draft.analysisMethod.description = event.target.value; }
        }, [draft.analysisMethod.description])
      ]),
      draftType === SKILL_TYPE_DERIVED_COLUMN ? el("div", { class: "skillSourceBlock" }, [
        el("div", { class: "skillBlockTitle" }, ["输出配置"]),
        el("label", { class: "skillField" }, [
          el("span", { class: "skillFieldLabel" }, ["新增列名称"]),
          el("input", {
            class: "skillInput",
            value: draft.output?.columnName || "智能分析结论",
            onInput: (event) => {
              draft.output = normalizeDerivedColumnOutput({ ...draft.output, columnName: event.target.value });
            }
          })
        ]),
        el("label", {
          class: "skillField",
          style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }
        }, [
          el("input", {
            type: "checkbox",
            checked: draft.trigger?.autoRunEnabled === true,
            onChange: (event) => {
              const normalized = normalizeDerivedColumnSkill({
                ...draft,
                trigger: {
                  ...draft.trigger,
                  autoRunEnabled: Boolean(event.target.checked)
                }
              });
              draft.trigger = normalized.trigger;
            }
          }),
          el("span", { class: "skillFieldLabel", style: { margin: 0 } }, ["自动执行"])
        ]),
        el("div", { class: "skillMeta" }, [
          "使用说明：自动执行默认关闭；关闭时刷新页面不会自动提交，但仍可在表格上方技能列表里手动点“更新”。"
        ]),
        el("div", { class: "skillMeta" }, [
          "列表变化后，自动执行会重新判断是否分析；如果当前页面已达到访问上限，本次仍会被保护。建议先通过“测试预览”确认字段、分析方法和结果样式，再决定是否开启自动执行。"
        ])
      ]) : null,
      el("div", { class: "skillActions" }, [
        el("button", { class: "btn primary", onClick: () => saveSkillDraft() }, [draft.id ? "保存修改" : "保存"]),
        el("button", { class: "btn", onClick: () => cancelSkillDraft() }, ["取消"])
      ])
    ]) : null;
    const draftNotice = draft ? el("div", { class: "skillFormNotice" }, [
      draft.id
        ? `当前正在修改技能。为避免和下面的技能目录混淆，目录已暂时收起；保存或取消后返回技能列表。`
        : `当前正在创建技能。为避免和已有技能目录混淆，目录已暂时收起；保存或取消后返回技能列表。`
    ]) : null;
    const cards = STATE.skills.map((skill) => {
      const sources = skill.sources || [skill.source].filter(Boolean);
      const sourceStatuses = STATE.skillSourceStatuses[skill.id] || {};
      const statuses = sources.map((source) => sourceStatuses[source.id]?.status || "checking");
      const currentStatuses = statuses.filter((item) => item !== "deferred");
      const status = currentStatuses.includes("missing")
        ? "missing"
        : currentStatuses.includes("ambiguous")
          ? "ambiguous"
        : currentStatuses.includes("changed")
          ? "changed"
          : currentStatuses.includes("checking")
            ? "checking"
            : currentStatuses.length ? "available" : "deferred";
      const type = skillTypeOf(skill);
      const normalizedDerived = type === SKILL_TYPE_DERIVED_COLUMN ? normalizeDerivedColumnSkill(skill) : null;
      const analysisPrompt = buildAnalysisPrompt(skill.analysisMethod);
      const selectedColumns = type === SKILL_TYPE_DERIVED_COLUMN ? normalizeDerivedColumnSelections(skill.selectedColumns) : [];
      return el("div", { class: "skillCard" }, [
        el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, [
          el("div", { class: "skillTitle", style: { flex: "1" } }, [
            el("span", { class: "skillNumber" }, [`#${skillNumberById.get(skill.id) || "-"}`]),
            el("span", {
              class: `skillTypeIcon ${type === SKILL_TYPE_DERIVED_COLUMN ? "column" : "table"}`,
              title: type === SKILL_TYPE_DERIVED_COLUMN ? "按列分析" : "整表分析"
            }, [type === SKILL_TYPE_DERIVED_COLUMN ? "列" : "表"]),
            skill.name
          ]),
          el("span", { class: `skillStatus ${status}` }, [statusLabels[status] || status])
        ]),
        el("div", { class: "skillMeta" }, [
          `数据源：共 ${sources.length} 个 · ${statuses.filter((item) => item === "available").length} 个可用`,
          ...sources.flatMap((source, index) => [
            el("br"),
            el("span", {
              class: "skillSourceStatusLine"
            }, [`${index + 1}. ${source.displayName || `数据源 ${index + 1}`} · 【${source.pageTitle || source.pageKey || "页面"}】· ${source.headers?.length || 0} 个字段 · ${sourceStatusLabel(sourceStatuses[source.id])}`])
          ]),
          el("br"),
          type === SKILL_TYPE_DERIVED_COLUMN
            ? el("span", { class: "skillMethodState ready" }, [analysisPrompt ? "使用自定义分析方法" : "使用默认分析方法"])
            : el("span", { class: `skillMethodState ${analysisPrompt ? "ready" : "empty"}` }, [analysisPrompt ? "分析方法已配置" : "尚未配置分析方法"]),
          type === SKILL_TYPE_DERIVED_COLUMN
            ? el("div", { style: { marginTop: "5px", color: "#475569" } }, [`自动执行：${normalizedDerived?.trigger?.autoRunEnabled ? "开启" : "关闭"}`])
            : null,
          type === SKILL_TYPE_DERIVED_COLUMN && selectedColumns.length
            ? el("div", { style: { marginTop: "5px", color: "#475569" } }, [`分析字段：${selectedColumns.map((column) => column.header || column.normalizedHeader).join("、")}`])
            : null,
          analysisPrompt ? el("div", { style: { marginTop: "5px", color: "#475569" } }, [`分析方法：${analysisPrompt.slice(0, 80)}${analysisPrompt.length > 80 ? "…" : ""}`]) : null
        ]),
        el("div", { class: "skillActions" }, [
          type === SKILL_TYPE_DERIVED_COLUMN
            ? el("button", {
              class: "btn primary",
              disabled: status === "missing" || status === "ambiguous" || status === "checking",
              onClick: async () => {
                const unavailable = collectSkillUnavailableSources(skill);
                if (unavailable.length) {
                  const names = unavailable
                    .map((item) => item.source.displayName || `数据源 ${item.index + 1}`)
                    .join("、");
                  showToast(`当前数据源不可用：${names}。请先点击“修改技能”重新选择数据源后再测试。`, 3500, { position: "center" });
                  return;
                }
                startDerivedColumnPreview(skill);
              }
            }, ["测试预览"])
            : el("button", {
              class: "btn primary",
              disabled: status === "missing" || status === "ambiguous" || status === "checking",
              onClick: async () => {
                const unavailable = collectSkillUnavailableSources(skill);
                if (unavailable.length) {
                  const names = unavailable
                    .map((item) => item.source.displayName || `数据源 ${item.index + 1}`)
                    .join("、");
                  showToast(`当前数据源不可用：${names}。请先点击“修改技能”重新选择数据源后再测试。`, 3500, { position: "center" });
                  return;
                }
                if (analysisPrompt) {
                  startSkillTest(skill);
                  return;
                }
                const accepted = await showConfirmDialog("当前技能未配置分析方法，点击修改技能配置");
                if (accepted) rebindSkill(skill.id);
              }
            }, ["测试技能"]),
          el("button", { class: "btn", onClick: () => rebindSkill(skill.id) }, ["修改技能"]),
          el("button", { class: "btn danger", onClick: () => deleteSkill(skill.id) }, ["删除"])
        ])
      ]);
    });
    const skillList = el("div", { class: "skillList" }, [
        el("div", { class: "skillSummary" }, [
          el("div", { class: "skillSummaryTitle" }, [
            el("span", { class: "skillSummaryTitleText" }, [`全部技能 ${STATE.skillCatalog.length} 个`]),
            el("button", { class: "skillTransfer", onClick: () => importAllSkills() }, ["导入技能"]),
            el("button", { class: "skillTransfer", disabled: !STATE.skillCatalog.length, onClick: () => exportAllSkills() }, ["导出技能"]),
            !draft ? el("button", { class: "skillCreateSummary", onClick: () => createSkillDraft() }, ["＋ 创建技能"]) : null,
            STATE.skillCatalog.length ? el("button", { class: "skillTransfer", onClick: () => deleteAllSkills() }, ["删除全部技能"]) : null
          ]),
          otherPages.length ? el("div", { class: "skillPagesLabel" }, ["其他页面技能："]) : null,
          otherPages.length ? el("div", {
            class: `skillPagesWrap${!STATE.skillCatalogExpanded ? " collapsed" : ""}`,
            id: "web2ai_skill_pages_wrap"
          }, [
            el("div", { class: "skillPages" }, otherPages.map((group) => el("button", {
              class: "skillPageLink",
              title: group.pageKey,
              onClick: () => switchToSkillPage(group.pageKey, group.pageUrl, group.source)
            }, [
              el("span", { class: "skillPageName" }, [`【${group.label}】`]),
              " ",
              el("span", { class: "skillPageCount" }, [String(group.count)]),
              " 个技能 ",
              el("span", { class: "skillPageNumbers" }, [
                `（${group.skills.map((skill) => `#${skillNumberById.get(skill.id) || "-"}`).join("、")}）`
              ])
            ])))
          ]) : null,
          STATE.skillCatalogCanToggle ? el("div", { class: "skillSummaryFooter" }, [
            el("button", {
              class: "skillToggleList",
              onClick: () => {
                STATE.skillCatalogExpanded = !STATE.skillCatalogExpanded;
                render();
              }
            }, [STATE.skillCatalogExpanded ? "收起" : "展开"])
          ]) : null
        ]),
        el("div", { class: "skillCurrentLabel" }, [
          el("span", { class: "skillCurrentLabelText" }, [
            `当前页面（${currentPageName} `,
            el("button", { class: "skillRename", onClick: () => renameCurrentSkillPage() }, ["修改"]),
            `）技能 ${STATE.skills.length} 个，具体如下：`
          ])
        ]),
        ...(cards.length ? cards : [el("div", { style: { padding: "24px 10px", textAlign: "center", color: "#64748b", fontSize: "12px" } }, ["当前页面还没有技能"])])
      ]);
    return el("div", { class: "skillBody", id: "web2ai_skills_body" }, [
      draftNotice,
      form,
      draft ? null : skillList
    ]);
  }
  const sideTabs = el("div", { class: "sideTabs", role: "tablist", "aria-label": "功能切换" }, [
    el("button", { class: `sideTab${STATE.activePanelTab === "chat" ? " active" : ""}`, role: "tab", onClick: () => { STATE.activePanelTab = "chat"; chrome.storage.sync.set({ lastPanelTab: "chat" }).catch(() => void 0); render(); } }, ["Chat"]),
    el("button", { class: `sideTab${STATE.activePanelTab === "skills" ? " active" : ""}`, role: "tab", onClick: () => { STATE.activePanelTab = "skills"; chrome.storage.sync.set({ lastPanelTab: "skills" }).catch(() => void 0); render(); } }, ["技能"])
  ]);
  const mainPane = el("div", { class: "mainPane" }, [header, STATE.activePanelTab === "skills" ? renderSkillsPanel() : body]);
  const card = el("div", { class: "card" }, [
    STATE.skillTest
      ? renderSkillWorkspace({ analysisModelControl, modelConfigReady, render })
      : el("div", { class: "workspace" }, [sideTabs, mainPane])
  ]);
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
  const skillResultPanel = refs.overlayShadow.getElementById("web2ai_skill_test_result_panel");
  if (skillResultPanel && STATE.skillTest?.pending) {
    skillResultPanel.scrollTop = skillResultPanel.scrollHeight;
  }
  const skillExecutionResultPanel = refs.overlayShadow.getElementById("web2ai_skill_execution_result_panel");
  if (skillExecutionResultPanel && STATE.skillTest?.pending) {
    skillExecutionResultPanel.scrollTop = skillExecutionResultPanel.scrollHeight;
  }
  const currentSkillsPanel = refs.overlayShadow.getElementById("web2ai_skills_body");
  if (currentSkillsPanel && STATE.activePanelTab === "skills") {
    currentSkillsPanel.scrollTop = Math.max(0, Number(STATE.skillsPanelScrollTop) || 0);
  }
  const skillPagesWrap = refs.overlayShadow.getElementById("web2ai_skill_pages_wrap");
  if (skillPagesWrap && STATE.activePanelTab === "skills") {
    const canToggleCatalog = skillPagesWrap.scrollHeight > 60 + 1;
    if (STATE.skillCatalogCanToggle !== canToggleCatalog) {
      STATE.skillCatalogCanToggle = canToggleCatalog;
      requestAnimationFrame(() => render());
    }
  }
}

function sliceRecentRounds(messages) {
  messages = messages.filter((message) => (
    !message.localOnly &&
    normalizeText(message.content) &&
    !normalizeText(message.content).startsWith("请求失败：")
  ));
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
  let resolvedSettings = null;
  if (STATE.contexts.some((context) => context.kind === "screenshot" && context.enabled !== false && context.imageData)) {
    const response = await sendToBackground({ type: "GET_SETTINGS", modelId: STATE.activeModelId });
    resolvedSettings = response?.data || null;
    if (!resolvedSettings?.supportsImages) {
      showToast(`当前模型“${resolvedSettings?.name || resolvedSettings?.model || "未配置"}”不支持图片，请切换模型`, 3000);
      return;
    }
  }
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
      const enabledContexts = STATE.contexts.filter((context) => context.enabled !== false);
      const enabledScreenshots = enabledContexts.filter((context) => context.kind === "screenshot" && context.imageData);
      // 控制单次请求体积；contexts 为 newest-first，优先发送最近截图。
      const screenshotsToUse = enabledScreenshots.slice(0, 5);
      if (screenshotsToUse.length < enabledScreenshots.length) {
        showToast(`单次最多发送 5 张截图，已使用最近 ${screenshotsToUse.length} 张`);
      }
      const historyMessages = recentMessages.map((m) => {
          if (m.role === "user") {
            const isLatest = m.ts === latestUserTs;
            if (!isLatest) return { role: "user", content: m.content };
            const userText = `USER_INPUT:\n${m.content}`;
            return screenshotsToUse.length
              ? {
                  role: "user",
                  content: [
                    { type: "text", text: userText },
                    ...screenshotsToUse.map((context) => ({
                      type: "image_url",
                      image_url: { url: context.imageData, detail: "auto" }
                    }))
                  ]
                }
              : { role: "user", content: userText };
          }
          return { role: m.role, content: m.content };
        });
      const settingsResp = resolvedSettings ? { data: resolvedSettings } : await sendToBackground({ type: "GET_SETTINGS", modelId: STATE.activeModelId });
      const settings = settingsResp?.data || {};
      const budget = calculateContextBudget({
        contextWindow: Math.max(8192, Number(settings.contextWindow) || 64000),
        maxOutputTokens: Math.max(256, Number(settings.maxOutputTokens) || 4096),
        messages: historyMessages
      });
      const textContexts = enabledContexts.filter((context) => context.kind !== "screenshot");
      const contextTokens = textContexts.reduce((sum, context) => sum + estimateTokens(context.text) + 24, 0);
      // 图片 token 由供应商按视觉编码计算，这里为每张图预留保护性预算。
      const textBudget = Math.max(0, budget.availableTokens - screenshotsToUse.length * 1200);
      const selection = selectContextsWithinTokenBudget(textContexts, textBudget);
      const contextsToUse = selection.contexts;
      if (contextsToUse.length < textContexts.length) {
        showToast(`上下文超出模型预算，已保留表头和最近数据（${contextsToUse.length}/${textContexts.length} 条）`);
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
    if (e?.code === "STREAM_STOPPED") {
      if (partialAssistant?.content) {
        partialAssistant.content = `${normalizeText(partialAssistant.content)}\n\n[已停止生成]`;
      } else if (STATE.messages.at(-1) === partialAssistant) {
        STATE.messages.pop();
      }
      refs.streamingMsgRef = null;
      showToast("已停止生成");
      render();
      return;
    }
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
      const emptyRetry = refs.streamingMsgRef;
      if (STATE.messages.at(-1) === emptyRetry && !normalizeText(emptyRetry?.content)) {
        STATE.messages.pop();
      }
      refs.streamingMsgRef = null;
      STATE.messages.push({
        role: "assistant",
        content: `请求失败：${String(e2?.message ?? e2)}`,
        localOnly: true,
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
  const hasScreenshot = enabledContexts.some((context) => context.kind === "screenshot" && context.imageData);
  const hasTableContext = enabledContexts.some((context) => context.kind === "table-header" || context.kind === "table-row");
  const isFirstTurn = STATE.messages.length === 0;

  if (!isFirstTurn && !hasInput) {
    showToast("请填写需要问的问题");
    return;
  }

  if (isFirstTurn && !hasInput && hasScreenshot && !hasTableContext) {
    showToast("请在输入框填写希望大模型对图片做什么分析，例如：识别异常、总结内容或提取关键信息", 4000);
    refs.overlayShadow?.getElementById("web2ai_input")?.focus();
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
        modelId: STATE.activeModelId,
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
  STATE.open = Boolean(open);
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
    '<span style="color:#fff;font-size:10px;font-weight:700;line-height:1;white-space:nowrap;">采</span>';

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
  initSkillWorkspaceController({ render, scheduleRender });
  ensureTableRowFab();

  if (IS_TOP_FRAME) {
    ensureHotkeys();
    ensureOverlay();
    ensureLauncherFab();
    refreshModelOptions().catch(() => void 0);
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
  initOverlay,
  refreshModelOptions,
  captureScreenshot,
  captureMultipleScreens,
  inspectMultiScreenScrollTarget,
  setMultiScreenScrollPosition,
  restoreMultiScreenScrollPosition,
  startSkillExecution
};
