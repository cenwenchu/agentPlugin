/**
 * @fileoverview 技能工作台专用样式。
 *
 * 与 overlay 的 Shadow DOM 共享基础按钮、气泡和排版规则；这里只保留
 * 测试/执行工作台独有的布局，避免视图调整继续扩大 overlay.js。
 */

const SKILL_WORKSPACE_CSS = `
    .skillTest { flex: 1; min-height: 0; display: flex; flex-direction: column; background: #f8fafc; }
    .skillTestHead, .skillExecutionHead { display: flex; align-items: center; gap: 14px; min-height: 58px; padding: 10px 16px; border-bottom: 1px solid rgba(0,0,0,.08); background: #fff; }
    .skillWorkspaceBack { flex: 0 0 auto; height: 34px; border-color: #2563eb; background: #2563eb; color: #fff; font-weight: 700; }
    .skillWorkspaceBack:hover { background: #1d4ed8; }
    .skillWorkspaceIdentity { flex: 0 1 auto; min-width: 140px; max-width: 36%; }
    .skillWorkspaceSpacer { flex: 1; min-width: 0; }
    .skillWorkspaceMode { margin-bottom: 2px; color: #64748b; font-size: 10px; font-weight: 650; }
    .skillTestTitle, .skillExecutionTitle { overflow: hidden; color: #0f172a; font-size: 18px; font-weight: 750; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
    .skillTestSteps { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(0,0,0,.07); background: #fff; }
    .skillTestStep { padding: 5px 9px; border-radius: 999px; background: #e2e8f0; color: #64748b; font-size: 11px; }
    .skillTestStep.done { background: #dcfce7; color: #166534; }
    .skillTestStep.active { background: #dbeafe; color: #1d4ed8; font-weight: 650; }
    .skillTestContent { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px, 36%) minmax(0, 1fr); gap: 12px; padding: 12px; overflow: hidden; }
    .skillTestPanel { min-height: 0; padding: 13px; border: 1px solid rgba(0,0,0,.08); border-radius: 12px; background: #fff; overflow: auto; }
    .skillTestMeta { margin-bottom: 10px; padding: 9px; border-radius: 9px; background: #f8fafc; color: #475569; font-size: 11px; line-height: 1.55; }
    .skillDataPreview { margin-bottom: 12px; border: 1px solid rgba(59,130,246,.18); border-radius: 10px; overflow: hidden; background: #fff; }
    .skillDataPreviewHead { display: flex; align-items: center; gap: 8px; padding: 8px 9px; background: #eff6ff; color: #1e3a8a; font-size: 11px; font-weight: 650; }
    .skillDataPreviewStatus { margin-left: auto; color: #64748b; font-size: 10px; font-weight: 500; }
    .skillDataPreviewStatus.collecting { color: #dc2626; font-weight: 700; }
    .skillDataPreviewBody { max-height: 190px; overflow: auto; padding: 8px; }
    .skillDataPreview table { width: max-content; min-width: 100%; border-collapse: collapse; color: #334155; font-size: 10px; }
    .skillDataPreview th, .skillDataPreview td { max-width: 180px; padding: 5px 6px; border: 1px solid #e2e8f0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .skillDataPreview th { position: sticky; top: 0; background: #f8fafc; color: #475569; }
    .skillDataPreviewEmpty { padding: 18px 8px; color: #64748b; font-size: 11px; text-align: center; }
    .skillDataPreviewMore { padding: 6px 2px 0; color: #64748b; font-size: 10px; text-align: center; }
    .skillDataSourceTabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
    .skillDataSourceTab { min-height: 28px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 4px 9px; background: #fff; color: #475569; font-size: 10px; cursor: pointer; }
    .skillDataSourceTab.active { border-color: #60a5fa; background: #eff6ff; color: #1d4ed8; font-weight: 700; }
    .skillDataSourceTab.complete::after { content: " · 已载入"; color: #15803d; }
    .skillDataSourceTab.loading::after { content: " · 采集中"; color: #dc2626; }
    .skillDataSourceTab.error::after { content: " · 失败"; color: #dc2626; font-weight: 700; }
    .skillRuntimeSourceActions { align-items: center; margin: 8px 0 12px; }
    .skillRuntimeSourceActions .btn { flex: 0 0 auto; height: 28px; box-sizing: border-box; padding: 0 10px; line-height: 26px; }
    .skillRuntimeSourceActions .skillMeta { margin-top: 0; line-height: 1.4; }
    .skillDataPreviewPager { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 4px 2px; color: #64748b; font-size: 10px; }
    .skillDataPreviewPager button { height: 24px; border: 1px solid #cbd5e1; border-radius: 7px; padding: 0 8px; background: #fff; color: #334155; font-size: 10px; cursor: pointer; }
    .skillDataPreviewPager button:disabled { color: #94a3b8; background: #f8fafc; cursor: not-allowed; }
    .skillTestMethod { width: 100%; min-height: 46px; max-height: 180px; box-sizing: border-box; resize: vertical; border: 1px solid rgba(0,0,0,.14); border-radius: 9px; padding: 10px; color: #111827; font: inherit; font-size: 12px; line-height: 1.55; }
    .skillTestResult { color: #111827; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
    .skillTestResult.waiting { color: #64748b; }
    /* 仅强调运行中的阶段反馈；空状态说明和最终模型结果沿用正文排版。 */
    .skillTestResult.skillResultStatus { padding: 12px 14px; border: 1px solid #bfdbfe; border-radius: 9px; background: #eff6ff; color: #1d4ed8; font-size: 14px; font-weight: 650; line-height: 1.6; }
    .skillTestError { color: #b91c1c; }
    .skillExecution { flex: 1; min-height: 0; display: flex; flex-direction: column; background: #f8fafc; }
    .skillExecutionStatus { padding: 7px 16px; border-bottom: 1px solid rgba(0,0,0,.07); background: #eff6ff; color: #1d4ed8; font-size: 11px; }
    .skillExecutionContent { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, 36%) minmax(0, 1fr); gap: 12px; padding: 12px; overflow: hidden; }
    .skillExecutionPanel { min-height: 0; padding: 13px; border: 1px solid rgba(0,0,0,.08); border-radius: 12px; background: #fff; overflow: auto; }
    .skillExecutionMethod { padding: 10px; border: 1px solid #e2e8f0; border-radius: 9px; background: #f8fafc; color: #334155; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
    .skillAnalysisModel { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; padding: 5px 7px; border: 1px solid #93c5fd; border-radius: 9px; background: #eff6ff; color: #1e3a8a; font-size: 11px; font-weight: 700; }
    .skillAnalysisModelHint { color: #64748b; font-size: 10px; font-weight: 500; white-space: nowrap; }
    .skillResultSection { height: auto; min-height: 0; margin: 0 0 12px; padding: 12px; border: 1px solid #dbe3ee; border-radius: 11px; background: #fff; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .skillResultSection.advice { border-left: 4px solid #7c3aed; background: #faf8ff; }
    .skillResultSection h1, .skillResultSection h2, .skillResultSection h3 { margin-top: 0; }
    .skillSuggestionListTitle { margin-bottom: 7px; color: #1e3a8a; font-size: 11px; font-weight: 700; }
    .skillResultActions { display: flex; gap: 7px; flex-wrap: wrap; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid #e5e7eb; }
    .skillResultTabs { display: flex; gap: 4px; margin: -3px -3px 12px; padding: 3px 3px 8px; border-bottom: 1px solid #e2e8f0; }
    .skillResultTab { height: 30px; border: 0; border-radius: 8px; padding: 0 12px; background: transparent; color: #64748b; font-size: 11px; font-weight: 650; cursor: pointer; }
    .skillResultTab.active { background: #dbeafe; color: #1d4ed8; }
    .skillMethodReviewActions { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
    .skillFollowup { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
    .skillFollowupInput { width: 100%; min-height: 72px; box-sizing: border-box; resize: vertical; border: 1px solid #cbd5e1; border-radius: 9px; padding: 9px 10px; color: #111827; font: inherit; font-size: 12px; line-height: 1.5; }
    .skillFollowupTurn { margin-top: 10px; }
    .skillFollowupQuestion { margin: 0 0 6px 15%; padding: 8px 10px; border-radius: 10px; background: #dbeafe; color: #1e3a8a; font-size: 11px; line-height: 1.5; }
    .skillFollowupAnswer { padding: 10px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; color: #111827; font-size: 12px; line-height: 1.55; }
`;

export { SKILL_WORKSPACE_CSS };
