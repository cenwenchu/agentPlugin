/**
 * @fileoverview 技能测试与执行工作台视图。
 *
 * 只负责基于现有会话状态构建 DOM，并把业务动作委托给 controller。
 * 保持既有 class/id 与事件时序，避免拆分影响已发布页面和端到端测试。
 */

import { STATE, clamp, normalizeText, refs } from "./state.js";
import { el } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { MAX_SKILL_COLLECTION_PAGES, MAX_SKILL_COLLECTION_ROWS } from "./skill-collection-model.js";
import { availableSkillRuntimeFileSlots } from "./skill-runtime-file-source.js";
import {
  clampSkillWorkspaceActiveSource, selectSkillWorkspacePreview, skillWorkspaceHasAllSourceData,
  skillWorkspaceResultStatusMessage
} from "./skill-workspace-state.js";
import {
  appendSkillMethodReview, continueSkillConversation, copySkillText, downloadSkillResult,
  leaveSkillWorkspace, removeSkillRuntimeSource, reviewSkillAnalysisMethod, runSkillTest,
  runDerivedColumnPreview, saveSkillTestMethod, stopSkillExecution, uploadSkillRuntimeFiles, viewSkillSubmittedPrompt
} from "./skill-workspace-controller.js";

function renderSkillWorkspace({ analysisModelControl, modelConfigReady = true, render: renderOverlay }) {
  const renderUsageBox = (lines = []) => el("div", { class: "skillUsageNote" }, [
    ...lines.flatMap((line, index) => index === 0 ? [line] : [el("br"), line])
  ]);
  const renderModelSetupHint = () => modelConfigReady
    ? null
    : el("div", { class: "skillTestError", style: { marginBottom: "10px" } }, ["当前模型尚未配置，请先点击右上角“去配置模型”。"]);

  function renderSkillTestPanel() {
    const test = STATE.skillTest;
    const sourceItems = test.dataSources || [];
    clampSkillWorkspaceActiveSource(test);
    const activeSource = sourceItems[test.activeDataSourceIndex] || { data: test.data, collection: test.collection, status: test.status };
    const activeData = activeSource.data;
    const loaded = skillWorkspaceHasAllSourceData(test);
    const finished = test.status === "complete";
    const testCollection = activeSource.collection || {};
    const testCollectionProgress = testCollection.phase === "scrolling"
      ? `正在采集第 ${testCollection.page || 1} 页 · 已滚动 ${testCollection.scrollSteps || 0} 次 · 已获取 ${testCollection.rowCount || 0} 行`
      : testCollection.phase === "restoring"
        ? `采集完成，正在恢复第一页 · 已获取 ${testCollection.rowCount || 0} 行`
        : `正在采集第 ${testCollection.page || 1} 页 · 已获取 ${testCollection.rowCount || 0} 行`;
    const steps = [
      { label: "1. 载入数据源", done: loaded, active: test.status === "loading" },
      { label: "2. 提交分析方法", done: finished || test.status === "analyzing", active: test.status === "submitting" },
      { label: "3. 查看实际结果", done: finished, active: test.status === "analyzing" || finished }
    ];
    const resultContent = test.error
      ? el("div", { class: "skillTestError" }, [`测试失败：${test.error}`])
      : test.response
        ? el("div", { class: "skillTestResult bubble assistant" }, [])
        : el("div", { class: `skillTestResult waiting${test.pending ? " skillResultStatus" : ""}` }, [
            test.pending
              ? skillWorkspaceResultStatusMessage(test)
              : "点击“开始测试”，这里将原样展示模型按照当前分析方法生成的结果。"
          ]);
    if (test.response && !test.error) resultContent.innerHTML = renderMarkdown(test.response);
    const resultActions = finished && test.response ? el("div", { class: "skillResultActions" }, [
      el("button", { class: "btn", disabled: test.pending, onClick: () => copySkillText(test.response, "分析结果已复制") }, ["复制结果"]),
      el("button", { class: "btn", disabled: test.pending, onClick: () => downloadSkillResult(test) }, ["下载结果"])
    ]) : null;
    const methodReviewResult = el("div", { class: "skillTestResult" }, []);
    if (test.methodReview) methodReviewResult.innerHTML = renderMarkdown(test.methodReview);
    else methodReviewResult.textContent = test.pending && test.resultTab === "method"
      ? "正在优化分析方法…"
      : "完成一次测试后，可在分析方法输入框下点击“优化分析方法”获取建议。";
    const methodReviewContent = el("div", {}, [
      test.methodReview ? el("div", { class: "skillMethodReviewActions" }, [
        el("button", { class: "btn primary", disabled: test.pending || test.methodReview.startsWith("优化失败："), onClick: () => appendSkillMethodReview() }, ["将建议加入分析方法"]),
        el("button", { class: "btn", disabled: test.pending, onClick: () => copySkillText(test.methodReview, "分析方法建议已复制") }, ["复制建议"])
      ]) : null,
      methodReviewResult
    ]);
    const sourceTabs = el("div", { class: "skillDataSourceTabs" }, sourceItems.map((item, index) => {
      const rowCount = item.data
        ? (item.data.totalRowCount ?? item.data.rowCount ?? 0)
        : item.status === "loading" ? (item.collection?.rowCount || 0) : null;
      const countText = rowCount === null ? "" : item.status === "loading" ? ` · 已获取 ${rowCount} 条` : ` · 共 ${rowCount} 条`;
      return el("button", {
        class: `skillDataSourceTab ${item.status || "ready"}${index === test.activeDataSourceIndex ? " active" : ""}`,
        onClick: () => { test.activeDataSourceIndex = index; renderOverlay(); }
      }, [`${index + 1}. ${item.name}${countText}`]);
    }));
    const runtimeSourceActions = el("div", { class: "skillActions skillRuntimeSourceActions" }, [
      el("button", { class: "btn", disabled: test.pending || availableSkillRuntimeFileSlots(sourceItems) === 0, onClick: () => uploadSkillRuntimeFiles() }, ["＋ 上传 CSV / Excel"]),
      activeSource.runtimeOnly ? el("button", { class: "btn danger", disabled: test.pending, onClick: () => removeSkillRuntimeSource(test.activeDataSourceIndex) }, ["移除临时数据源"]) : null,
      el("span", { class: "skillMeta" }, ["文件仅用于本次测试，不保存到技能中"])
    ]);
    const previewPageSize = 10;
    const preview = selectSkillWorkspacePreview(activeSource, previewPageSize);
    const allPreviewRows = preview.rows;
    const previewPageCount = preview.pageCount;
    activeSource.previewPage = preview.page;
    const previewRows = preview.pageRows;
    const previewHeaders = activeData?.headers || [];
    const dataPreview = el("div", { class: "skillDataPreview" }, [
      el("div", { class: "skillDataPreviewHead" }, [
        "数据源预览",
        el("span", { class: `skillDataPreviewStatus${activeSource.status === "loading" ? " collecting" : ""}` }, [
          activeSource.status === "loading"
            ? testCollectionProgress
            : activeSource.error
              ? `载入失败：${activeSource.error}`
            : activeData
              ? `当前已渲染共 ${activeData.totalRowCount ?? activeData.rowCount ?? 0} 行，本次提交 ${activeData.rowCount || 0} 行`
              : "尚未载入"
        ])
      ]),
      el("div", { class: "skillDataPreviewBody" }, [
        activeSource.status === "loading"
          ? el("div", { class: "skillDataPreviewEmpty" }, ["正在载入数据源，请稍候…"])
          : activeSource.error
            ? el("div", { class: "skillTestError" }, [activeSource.error])
          : previewRows.length
            ? el("table", {}, [
                el("thead", {}, [el("tr", {}, previewHeaders.map((header) => el("th", { title: header }, [header])))]),
                el("tbody", {}, previewRows.map((row) => el("tr", {}, row.map((cell) => el("td", { title: cell }, [cell])))))
              ])
            : el("div", { class: "skillDataPreviewEmpty" }, [activeData ? "已定位数据源，但当前没有可读取的数据行。" : "开始测试后将在这里展示部分数据。"]),
        allPreviewRows.length > previewPageSize ? el("div", { class: "skillDataPreviewPager" }, [
          el("button", { disabled: activeSource.previewPage <= 1, onClick: () => { activeSource.previewPage--; renderOverlay(); } }, ["上一页"]),
          el("span", {}, [`第 ${activeSource.previewPage} / ${previewPageCount} 页 · 共 ${allPreviewRows.length} 条`]),
          el("button", { disabled: activeSource.previewPage >= previewPageCount, onClick: () => { activeSource.previewPage++; renderOverlay(); } }, ["下一页"])
        ]) : allPreviewRows.length ? el("div", { class: "skillDataPreviewMore" }, [`共 ${allPreviewRows.length} 条`]) : null
      ])
    ]);
    return el("div", { class: "skillTest" }, [
      el("div", { class: "skillTestHead" }, [
        el("button", { class: "btn skillWorkspaceBack", disabled: test.pending || test.methodSaving, onClick: () => leaveSkillWorkspace() }, ["← 返回"]),
        el("div", { class: "skillWorkspaceIdentity" }, [
          el("div", { class: "skillWorkspaceMode" }, ["测试技能"]),
          el("div", { class: "skillTestTitle", title: test.skillName }, [test.skillName])
        ]),
        analysisModelControl,
        el("div", { class: "skillWorkspaceSpacer" })
      ]),
      el("div", { class: "skillTestSteps" }, steps.map((step) => el("span", {
        class: `skillTestStep${step.done ? " done" : step.active ? " active" : ""}`
      }, [step.label]))),
      el("div", { class: "skillTestContent" }, [
        el("div", { class: "skillTestPanel" }, [
          el("div", { class: "skillBlockTitle" }, ["本次测试配置"]),
          el("div", { class: "skillTestMeta" }, [
            loaded
              ? `共 ${sourceItems.length} 个数据源，已载入 ${sourceItems.filter((item) => item.data).length} 个，失败 ${sourceItems.filter((item) => item.error).length} 个${test.mode === "test" ? "；本次测试会话将复用已载入数据" : ""}`
              : `共 ${sourceItems.length} 个数据源。开始测试后将依次采集，每个最多 ${MAX_SKILL_COLLECTION_PAGES} 页或 ${MAX_SKILL_COLLECTION_ROWS} 行。`
          ]),
          renderUsageBox([
            "场景说明：整表分析适合让 AI 对整张表做整体总结，例如问题归纳、趋势判断、异常原因分析、经营建议等，更适合先看全局结论。",
            `使用说明：开始测试后会依次采集当前绑定的 ${sourceItems.length} 个数据源；每个数据源最多读取 ${MAX_SKILL_COLLECTION_PAGES} 页或 ${MAX_SKILL_COLLECTION_ROWS} 行。满意后可直接保存当前分析方法。`
          ]),
          sourceTabs,
          runtimeSourceActions,
          dataPreview,
          el("label", { class: "skillFieldLabel" }, ["分析方法（可根据反馈直接修改）"]),
          el("textarea", {
            class: "skillTestMethod",
            rows: clamp(normalizeText(test.method).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 46)), 0), 2, 8),
            disabled: test.pending || test.methodSaving,
            onInput: (event) => {
              test.method = event.target.value;
              event.target.rows = clamp(normalizeText(test.method).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 46)), 0), 2, 8);
              // 输入时不重绘整个工作台，否则会替换 textarea 并打断光标；但
              // 必须立即同步保存按钮，不能让它沿用进入页面时的 disabled 状态。
              const saveButton = refs.overlayShadow?.getElementById("web2ai_skill_save_test_method");
              if (saveButton) {
                saveButton.disabled = test.pending || test.methodSaving || !finished ||
                  normalizeText(test.method) === normalizeText(test.savedMethod);
              }
            }
          }, [test.method]),
          renderModelSetupHint(),
          el("div", { class: "skillActions" }, [
            el("button", { class: "btn primary", disabled: test.pending, style: test.pending ? { display: "none" } : {}, onClick: () => runSkillTest() }, [
              test.pending ? "执行中…" : test.attempts ? (test.mode === "execute" ? "重新执行" : "再次测试") : (test.mode === "execute" ? "执行技能" : "开始测试")
            ]),
            el("button", { class: "btn danger", style: test.pending ? {} : { display: "none" }, onClick: () => stopSkillExecution() }, [test.status === "loading" ? "停止采集并分析" : "停止测试"]),
            el("button", {
              id: "web2ai_skill_save_test_method",
              class: "btn",
              disabled: test.pending || test.methodSaving || !finished || normalizeText(test.method) === normalizeText(test.savedMethod),
              onClick: () => saveSkillTestMethod()
            }, [test.methodSaving ? "保存中…" : "满意并保存"]),
            el("button", { class: "btn", disabled: !test.submittedPrompt, onClick: () => viewSkillSubmittedPrompt(test) }, ["查看提交内容"]),
            el("button", { class: "btn", disabled: test.pending || !finished || !normalizeText(test.response), onClick: () => reviewSkillAnalysisMethod() }, [test.methodReview ? "重新优化分析方法" : "优化分析方法"])
          ])
        ]),
        el("div", { id: "web2ai_skill_test_result_panel", class: "skillTestPanel" }, [
          el("div", { class: "skillResultTabs", role: "tablist" }, [
            el("button", { class: `skillResultTab${test.resultTab !== "method" ? " active" : ""}`, onClick: () => { test.resultTab = "result"; renderOverlay(); } }, ["分析结果"]),
            el("button", { class: `skillResultTab${test.resultTab === "method" ? " active" : ""}`, onClick: () => { test.resultTab = "method"; renderOverlay(); } }, ["优化分析方法"])
          ]),
          test.resultTab === "method"
            ? methodReviewContent
            : el("div", {}, [resultActions, resultContent])
        ])
      ])
    ]);
  }

  function renderSkillExecutionPanel() {
    const execution = STATE.skillTest;
    const sourceItems = execution.dataSources || [];
    clampSkillWorkspaceActiveSource(execution);
    const activeSource = sourceItems[execution.activeDataSourceIndex] || { data: execution.data, collection: execution.collection, status: execution.status };
    const activeData = activeSource.data;
    const finished = execution.status === "complete";
    const collection = activeSource.collection || {};
    const collectionProgress = activeSource.status === "loading"
      ? collection.phase === "stopping"
        ? `正在停止采集，已采集 ${collection.rowCount || 0} 行`
        : collection.phase === "restoring"
          ? `采集完成，正在恢复第一页 · 共 ${collection.rowCount || 0} 行`
        : collection.phase === "scrolling"
          ? `正在采集第 ${collection.page || 1} 页 · 已滚动 ${collection.scrollSteps || 0} 次 · 已采集 ${collection.rowCount || 0} 行`
        : collection.phase === "turning"
          ? `第 ${collection.page || collection.pages || 1} 页完成，正在翻页 · 已采集 ${collection.rowCount || 0} 行`
          : collection.phase === "page-complete"
            ? `第 ${collection.pages || 1} 页采集完成 · 已采集 ${collection.rowCount || 0} 行`
            : `正在采集第 ${collection.page || 1} 页 · 已采集 ${collection.rowCount || 0} 行`
      : "";
    const sourceTabs = el("div", { class: "skillDataSourceTabs" }, sourceItems.map((item, index) => {
      const rowCount = item.data
        ? (item.data.totalRowCount ?? item.data.rowCount ?? 0)
        : item.status === "loading" ? (item.collection?.rowCount || 0) : null;
      const countText = rowCount === null ? "" : item.status === "loading" ? ` · 已获取 ${rowCount} 条` : ` · 共 ${rowCount} 条`;
      return el("button", {
        class: `skillDataSourceTab ${item.status || "ready"}${index === execution.activeDataSourceIndex ? " active" : ""}`,
        onClick: () => { execution.activeDataSourceIndex = index; renderOverlay(); }
      }, [`${index + 1}. ${item.name}${countText}`]);
    }));
    const runtimeSourceActions = el("div", { class: "skillActions skillRuntimeSourceActions" }, [
      el("button", { class: "btn", disabled: execution.pending || availableSkillRuntimeFileSlots(sourceItems) === 0, onClick: () => uploadSkillRuntimeFiles() }, ["＋ 上传 CSV / Excel"]),
      activeSource.runtimeOnly ? el("button", { class: "btn danger", disabled: execution.pending, onClick: () => removeSkillRuntimeSource(execution.activeDataSourceIndex) }, ["移除临时数据源"]) : null,
      el("span", { class: "skillMeta" }, ["文件仅用于本次执行，不保存到技能中"])
    ]);
    const previewPageSize = 10;
    const preview = selectSkillWorkspacePreview(activeSource, previewPageSize);
    const allPreviewRows = preview.rows;
    const previewPageCount = preview.pageCount;
    activeSource.previewPage = preview.page;
    const previewRows = preview.pageRows;
    const previewHeaders = activeData?.headers || [];
    const dataPreview = el("div", { class: "skillDataPreview" }, [
      el("div", { class: "skillDataPreviewHead" }, [
        "数据源",
        el("span", { class: `skillDataPreviewStatus${activeSource.status === "loading" ? " collecting" : ""}` }, [
          activeSource.status === "loading"
            ? collectionProgress
            : activeSource.error
              ? `载入失败：${activeSource.error}`
            : activeData
              ? `已读取 ${activeData.totalRowCount ?? activeData.rowCount ?? 0} 行，本次使用 ${activeData.rowCount || 0} 行`
              : "等待载入"
        ])
      ]),
      el("div", { class: "skillDataPreviewBody" }, [
        activeSource.status === "loading"
          ? el("div", { class: "skillDataPreviewEmpty" }, ["正在读取页面数据…"])
          : activeSource.error
            ? el("div", { class: "skillTestError" }, [activeSource.error])
          : previewRows.length
            ? el("table", {}, [
                el("thead", {}, [el("tr", {}, previewHeaders.map((header) => el("th", { title: header }, [header])))]),
                el("tbody", {}, previewRows.map((row) => el("tr", {}, row.map((cell) => el("td", { title: cell }, [cell])))))
              ])
            : el("div", { class: "skillDataPreviewEmpty" }, [activeData ? "当前没有可读取的数据行" : "数据载入后将在这里展示部分内容"]),
        allPreviewRows.length > previewPageSize ? el("div", { class: "skillDataPreviewPager" }, [
          el("button", { disabled: activeSource.previewPage <= 1, onClick: () => { activeSource.previewPage--; renderOverlay(); } }, ["上一页"]),
          el("span", {}, [`第 ${activeSource.previewPage} / ${previewPageCount} 页 · 共 ${allPreviewRows.length} 条`]),
          el("button", { disabled: activeSource.previewPage >= previewPageCount, onClick: () => { activeSource.previewPage++; renderOverlay(); } }, ["下一页"])
        ]) : allPreviewRows.length ? el("div", { class: "skillDataPreviewMore" }, [`共 ${allPreviewRows.length} 条`]) : null
      ])
    ]);
    const analysisResult = el("div", {
      class: `skillTestResult${execution.response ? " bubble assistant" : ` waiting${execution.pending ? " skillResultStatus" : ""}`}`
    }, []);
    if (execution.error) {
      analysisResult.className = "skillTestError";
      analysisResult.textContent = `执行失败：${execution.error}`;
    } else if (execution.response) {
      analysisResult.innerHTML = renderMarkdown(execution.response);
    } else {
      analysisResult.textContent = execution.pending
        ? skillWorkspaceResultStatusMessage(execution)
        : "等待执行";
    }
    const followupTurns = (execution.followups || []).map((turn) => {
      const answer = el("div", { class: "skillFollowupAnswer" }, []);
      answer.innerHTML = turn.response ? renderMarkdown(turn.response) : "正在等待回答…";
      return el("div", { class: "skillFollowupTurn" }, [
        el("div", { class: "skillFollowupQuestion" }, [turn.question]),
        answer
      ]);
    });
    const statusText = execution.status === "loading"
      ? collectionProgress
      : execution.status === "submitting" || execution.status === "analyzing"
        ? skillWorkspaceResultStatusMessage(execution)
        : finished
          ? "分析完成"
          : execution.error
            ? "执行未完成"
            : "准备执行";
    return el("div", { class: "skillExecution" }, [
      el("div", { class: "skillExecutionHead" }, [
        el("button", { class: "btn skillWorkspaceBack", disabled: execution.pending, onClick: () => leaveSkillWorkspace() }, ["← 返回"]),
        el("div", { class: "skillWorkspaceIdentity" }, [
          el("div", { class: "skillWorkspaceMode" }, ["执行技能"]),
          el("div", { class: "skillExecutionTitle", title: execution.skillName }, [execution.skillName])
        ]),
        analysisModelControl,
        el("div", { class: "skillWorkspaceSpacer" })
      ]),
      el("div", { class: "skillExecutionStatus" }, [statusText]),
      el("div", { class: "skillExecutionContent" }, [
        el("div", { class: "skillExecutionPanel" }, [
          el("div", { class: "skillBlockTitle" }, ["数据源"]),
          sourceTabs,
          runtimeSourceActions,
          dataPreview,
          el("div", { class: "skillBlockTitle" }, ["分析方法"]),
          el("div", { class: "skillExecutionMethod" }, [execution.method]),
          renderModelSetupHint(),
          execution.submittedPrompt ? el("div", { class: "skillActions" }, [
            el("button", { class: "btn", onClick: () => viewSkillSubmittedPrompt(execution) }, ["查看提交内容"])
          ]) : null,
          !execution.pending && !execution.attempts && !execution.error ? el("div", { class: "skillActions" }, [
            el("button", { id: "web2ai_run_skill", class: "btn primary", onClick: () => runSkillTest() }, ["执行技能"])
          ]) : null,
          execution.data && !execution.pending ? el("div", { class: "skillActions" }, [
            el("button", { class: "btn primary", onClick: () => runSkillTest({ reuseData: true }) }, ["重新分析"])
          ]) : null,
          execution.pending
            ? el("div", { class: "skillActions" }, [
                el("button", { class: "btn danger", onClick: () => stopSkillExecution() }, [execution.status === "loading" ? "停止采集并分析" : "停止执行"])
              ])
            : execution.error
              ? el("div", { class: "skillActions" }, [
                  el("button", { class: "btn primary", onClick: () => runSkillTest() }, ["重新执行"])
                ])
              : null,
          finished ? el("div", { class: "skillFollowup" }, [
            el("div", { class: "skillBlockTitle" }, ["继续问"]),
            el("textarea", {
              class: "skillFollowupInput",
              placeholder: "基于本次分析结果继续提问…",
              disabled: execution.pending,
              onInput: (event) => { execution.followupDraft = event.target.value; }
            }, [execution.followupDraft || ""]),
            el("div", { class: "skillActions" }, [
              el("button", { class: "btn primary", disabled: execution.pending, onClick: () => continueSkillConversation() }, ["发送"])
            ])
          ]) : null
        ]),
        el("div", { id: "web2ai_skill_execution_result_panel", class: "skillExecutionPanel" }, [
          el("div", { class: "skillBlockTitle" }, [execution.pending ? "正在生成分析结果" : "分析结果"]),
          finished && execution.response ? el("div", { class: "skillResultActions" }, [
            el("button", { class: "btn", onClick: () => copySkillText(execution.response, "分析结果已复制") }, ["复制结果"]),
            el("button", { class: "btn", onClick: () => downloadSkillResult(execution) }, ["下载结果"])
          ]) : null,
          analysisResult,
          ...followupTurns
        ])
      ])
    ]);
  }

  function renderDerivedPreviewPanel() {
    const test = STATE.skillTest;
    const sourceItem = test.dataSources?.[0] || { data: null, status: test.status };
    const activeData = sourceItem.data;
    const preview = test.derivedPreview || { rows: [], headers: [] };
    const sourcePreview = selectSkillWorkspacePreview(sourceItem, 10);
    sourceItem.previewPage = sourcePreview.page;
    const sourcePreviewRows = sourcePreview.pageRows;
    const previewPageSize = 10;
    const previewPageCount = Math.max(1, Math.ceil((preview.rows || []).length / previewPageSize));
    const currentPreviewPage = Math.min(previewPageCount, Math.max(1, Math.trunc(Number(test.previewPage) || 1)));
    test.previewPage = currentPreviewPage;
    const previewRows = (preview.rows || []).slice((currentPreviewPage - 1) * previewPageSize, currentPreviewPage * previewPageSize);
    const finished = test.status === "complete";
    const aiColumnName = preview.outputColumnName || test.output?.columnName || "智能分析结论";
    const selectedHeaders = Array.isArray(preview.headers) ? preview.headers.filter((header) => header !== aiColumnName) : [];
    const displayHeaders = [aiColumnName, ...selectedHeaders];
    const totalColumns = displayHeaders.length;
    const renderPreviewValueCell = (value, title = "", { ai = false } = {}) => {
      const content = el("div", { class: "skillDerivedPreviewCell" }, []);
      content.textContent = String(value ?? "");
      return el("td", {
        title,
        class: ai ? "skillDerivedPreviewAiCol sticky" : ""
      }, [content]);
    };
    const renderPreviewConclusionCell = (row) => {
      const message = row.conclusion || (row.status === "error" ? `分析失败：${row.error}` : "等待分析");
      const content = el("div", {
        class: `skillDerivedPreviewCell markdown skillDerivedPreviewAiBox${row.status === "error" ? " skillTestError" : ""}`
      }, []);
      content.innerHTML = renderMarkdown(message);
      return el("td", {
        title: row.error ? `${row.conclusion}${row.error ? `（${row.error}）` : ""}` : row.conclusion,
        class: "skillDerivedPreviewAiCol sticky"
      }, [content]);
    };
    const colgroup = el("colgroup", {}, displayHeaders.map((header, index) => {
      const isAi = index === 0;
      let width = "";
      if (totalColumns <= 4) {
        width = isAi ? "22.5%" : `${Math.floor(77.5 / Math.max(1, totalColumns - 1))}%`;
      } else if (index < 4) {
        width = isAi ? "208px" : "180px";
      } else {
        width = "160px";
      }
      return el("col", { style: { width } });
    }));
    const resultContent = test.error
      ? el("div", { class: "skillTestError" }, [`测试失败：${test.error}`])
      : previewRows.length
        ? el("div", { class: "skillDerivedPreviewResultBody" }, [
            el("table", { class: totalColumns > 4 ? "has-extra-columns" : "" }, [
              colgroup,
              el("thead", {}, [el("tr", {}, displayHeaders.map((header, index) => el("th", {
                title: header,
                class: index === 0 ? "skillDerivedPreviewAiCol sticky" : ""
              }, [header])))]),
              el("tbody", {}, previewRows.map((row) => el("tr", {}, [
                renderPreviewConclusionCell(row),
                ...row.selectedValues.map((cell) => renderPreviewValueCell(cell, cell))
              ])))
            ]),
            (preview.rows || []).length > previewPageSize ? el("div", { class: "skillDataPreviewPager" }, [
              el("button", { disabled: currentPreviewPage <= 1, onClick: () => { test.previewPage--; renderOverlay(); } }, ["上一页"]),
              el("span", {}, [`第 ${currentPreviewPage} / ${previewPageCount} 页 · 共 ${(preview.rows || []).length} 条`]),
              el("button", { disabled: currentPreviewPage >= previewPageCount, onClick: () => { test.previewPage++; renderOverlay(); } }, ["下一页"])
            ]) : null
          ])
        : el("div", { class: `skillTestResult waiting${test.pending ? " skillResultStatus" : ""}` }, [
            test.pending
              ? skillWorkspaceResultStatusMessage(test)
              : "点击“开始测试预览”，这里会展示所选字段和按列分析结论。"
          ]);
    return el("div", { class: "skillTest" }, [
      el("div", { class: "skillTestHead" }, [
        el("button", { class: "btn skillWorkspaceBack", disabled: test.pending || test.methodSaving, onClick: () => leaveSkillWorkspace() }, ["← 返回"]),
        el("div", { class: "skillWorkspaceIdentity" }, [
          el("div", { class: "skillWorkspaceMode" }, ["测试按列分析"]),
          el("div", { class: "skillTestTitle", title: test.skillName }, [test.skillName])
        ]),
        analysisModelControl,
        el("div", { class: "skillWorkspaceSpacer" })
      ]),
      el("div", { class: "skillTestSteps" }, [
        el("span", { class: `skillTestStep${activeData ? " done" : test.status === "loading" ? " active" : ""}` }, ["1. 读取当前页前 20 行"]),
        el("span", { class: `skillTestStep${finished ? " done" : test.status === "submitting" ? " active" : ""}` }, ["2. 去重后提交模型"]),
        el("span", { class: `skillTestStep${finished ? " done active" : test.status === "analyzing" ? " active" : ""}` }, ["3. 查看预览结果"])
      ]),
      el("div", { class: "skillTestContent" }, [
        el("div", { class: "skillTestPanel" }, [
          el("div", { class: "skillBlockTitle" }, ["本次测试配置"]),
          el("div", { class: "skillTestMeta" }, [
            `当前仅测试 1 个数据源；最多读取前 20 行，并且只提交唯一字段内容。`
          ]),
          renderUsageBox([
            "场景说明：按列分析适合针对表格中选中的多行生成单独结论，例如风险识别、异常判断、优先级建议、补充标签等，更适合把结果作为新增列贴回表格查看。",
            "使用说明：测试预览只验证当前页前 20 行的抽数、去重和结果格式，不会开启正式自动执行。满意后请先保存技能；若希望页面刷新时自动分析，再去技能配置中开启“自动执行”。"
          ]),
          el("div", { class: "skillMeta" }, [`分析字段：${(test.selectedColumns || []).map((column) => column.header || column.normalizedHeader).join("、") || "未选择"}`]),
          el("div", { class: "skillMeta", style: { marginTop: "6px" } }, [`新增列名称：${test.output?.columnName || "智能分析结论"}`]),
          el("div", { class: "skillDataPreview", style: { marginTop: "12px" } }, [
            el("div", { class: "skillDataPreviewHead" }, [
              "当前页数据预览",
              el("span", { class: `skillDataPreviewStatus${sourceItem.status === "loading" ? " collecting" : ""}` }, [
                sourceItem.status === "loading"
                  ? "正在读取当前页数据…"
                  : sourceItem.error
                    ? `读取失败：${sourceItem.error}`
                    : activeData
                      ? `共识别 ${activeData.totalRowCount ?? activeData.rowCount ?? 0} 行，本次预览 ${Math.min(20, activeData.rowCount || 0)} 行`
                      : "开始测试后将在这里展示当前页数据"
              ])
            ]),
            el("div", { class: "skillDataPreviewBody" }, [
              sourcePreviewRows.length
                ? el("table", {}, [
                    el("thead", {}, [el("tr", {}, (activeData?.headers || []).map((header) => el("th", { title: header }, [header])))]),
                    el("tbody", {}, sourcePreviewRows.map((row) => el("tr", {}, row.map((cell) => el("td", { title: cell }, [cell])))))
                  ])
                : el("div", { class: "skillDataPreviewEmpty" }, [sourceItem.status === "loading" ? "正在读取…" : "开始测试后将在这里展示当前页部分数据。"])
            ])
          ]),
          el("label", { class: "skillFieldLabel" }, ["分析方法（可为空，留空时使用默认分析方法）"]),
          el("textarea", {
            class: "skillTestMethod",
            rows: clamp(normalizeText(test.method).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 46)), 0) || 2, 2, 8),
            disabled: test.pending || test.methodSaving,
            placeholder: "例如：识别高风险、异常、矛盾和值得关注的业务情况。留空则使用默认分析方法。",
            onInput: (event) => {
              test.method = event.target.value;
              event.target.rows = clamp(normalizeText(test.method).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 46)), 0) || 2, 2, 8);
              const saveButton = refs.overlayShadow?.getElementById("web2ai_skill_save_test_method");
              if (saveButton) {
                saveButton.disabled = test.pending || test.methodSaving || !finished ||
                  normalizeText(test.method) === normalizeText(test.savedMethod);
              }
            }
          }, [test.method]),
          el("div", { class: "skillMeta" }, [
            normalizeText(test.method)
              ? "当前使用自定义分析方法。"
              : "当前将使用默认分析方法。"
          ]),
          renderModelSetupHint(),
          el("div", { class: "skillActions" }, [
            el("button", { class: "btn primary", disabled: test.pending, style: test.pending ? { display: "none" } : {}, onClick: () => runDerivedColumnPreview() }, [
              test.attempts ? "再次测试预览" : "开始测试预览"
            ]),
            el("button", {
              id: "web2ai_skill_save_test_method",
              class: "btn",
              disabled: test.pending || test.methodSaving || !finished || normalizeText(test.method) === normalizeText(test.savedMethod),
              onClick: () => saveSkillTestMethod()
            }, [test.methodSaving ? "保存中…" : "满意并保存"]),
            el("button", { class: "btn", disabled: !test.submittedPrompt, onClick: () => viewSkillSubmittedPrompt(test) }, ["查看提交内容"])
          ])
        ]),
        el("div", { class: "skillTestPanel" }, [
          el("div", { class: "skillBlockTitle" }, ["预览结果"]),
          el("div", { class: "skillUsageNote" }, [
            "结果说明：这里展示的是测试预览结果。正式运行时，页面会以新增列的方式展示 AI 结论；如果关闭自动执行，则只会在你手动点击“更新”后重新提交并展示。"
          ]),
          preview.rows?.length ? el("div", { class: "skillMeta" }, [
            `本次预览 ${(preview.totalPreviewCount || preview.rows.length)} 行，实际提交 ${(preview.uniqueRequestCount || 0)} 个唯一内容指纹${preview.usedDefaultMethod ? "，使用默认分析方法" : ""}${preview.failedFingerprints?.length ? `，失败 ${preview.failedFingerprints.length} 条` : ""}。`
          ]) : null,
          resultContent
        ])
      ])
    ]);
  }


  return STATE.skillTest?.mode === "derived-preview"
    ? renderDerivedPreviewPanel()
    : STATE.skillTest?.mode === "execute"
    ? renderSkillExecutionPanel()
    : renderSkillTestPanel();
}

export { renderSkillWorkspace };
