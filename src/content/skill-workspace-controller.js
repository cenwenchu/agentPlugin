/**
 * @fileoverview 技能工作台生命周期控制器。
 *
 * 控制器持有全局会话入口和跨 frame 采集进度入口，但不导入 overlay.js。
 * Overlay 初始化时注入 render，避免形成 controller → overlay 的循环依赖。
 */

import { DEBUG, STATE, refs, uid, normalizeText } from "./state.js";
import { streamChat, stopGeneration, sendToBackground } from "./messaging.js";
import { showConfirmDialog, showPromptDialog, showTextDialog } from "./dialog.js";
import { showToast } from "./toast.js";
import { buildAnalysisPrompt, saveSkillAnalysisMethod, updateSkillSourceHeaders } from "./skills.js";
import {
  buildSkillRequestPrompt, calculateSkillRequestBudget, incompleteSkillDataSources
} from "./skill-request-model.js";
import {
  buildDerivedColumnPreviewPrompt,
  buildDerivedPreviewRows,
  calculateDerivedColumnPreviewBatchSize
} from "./derived-column-request-model.js";
import { parseDerivedColumnResults } from "./derived-column-result-parser.js";
import {
  MAX_SKILL_COLLECTION_PAGES, MAX_SKILL_COLLECTION_ROWS, parseSkillCollectionPageInput
} from "./skill-collection-model.js";
import {
  MAX_SKILL_RUNTIME_FILES, availableSkillRuntimeFileSlots, chooseSkillRuntimeFiles,
  loadSkillRuntimeFileSources, resolveSkillRuntimeSheet
} from "./skill-runtime-file-source.js";
import {
  cancelSkillWorkspaceCollectionPageSelection, clampSkillWorkspaceActiveSource,
  createSkillWorkspaceSession, invalidateSkillWorkspaceResult, skillWorkspaceHasAllSourceData,
  skillWorkspaceMethodDirty, updateSkillWorkspaceCollectionProgress
} from "./skill-workspace-state.js";

let renderWorkspace = () => void 0;
let scheduleWorkspaceRender = () => renderWorkspace();

function initSkillWorkspaceController({ render, scheduleRender } = {}) {
  if (typeof render === "function") renderWorkspace = render;
  if (typeof scheduleRender === "function") scheduleWorkspaceRender = scheduleRender;
}

function openSkillWorkspace({ skill, method, mode = "test", currentPageKey = "" } = {}) {
  STATE.skillTest = createSkillWorkspaceSession({ skill, method, mode, currentPageKey });
  STATE.open = true;
  renderWorkspace();
  return STATE.skillTest;
}

function applySkillWorkspaceCollectionProgress(collectionId, progress) {
  if (!updateSkillWorkspaceCollectionProgress(STATE.skillTest, collectionId, progress)) return false;
  STATE.open = true;
  refs.suppressPanelCloseUntil = Date.now() + 1000;
  renderWorkspace();
  return true;
}

async function reviewSkillAnalysisMethod() {
  const test = STATE.skillTest;
  if (!test || test.pending || test.status !== "complete" || !normalizeText(test.response)) return;
  test.pending = true;
  test.methodReview = "";
  test.resultTab = "method";
  renderWorkspace();
  const prompt = [
    "请评估下面的分析方法是否清晰、完整，重点检查：",
    "1. 分析条件是否明确；",
    "2. 输出格式是否明确；",
    "3. 是否存在容易产生歧义的表达。",
    "只提出必要的修改建议，不要重新分析业务数据。建议中请给出可直接追加或替换的简短范例。",
    `\n【分析方法】\n${normalizeText(test.method)}`,
    `\n【本次实际输出】\n${normalizeText(test.response)}`
  ].join("\n");
  try {
    await streamChat({
      messages: [{ role: "user", content: prompt }],
      debugLabel: "skill-method-review",
      onChunk: (delta) => {
        test.methodReview += delta;
        scheduleWorkspaceRender();
      }
    });
    test.methodReview = normalizeText(test.methodReview) || "模型未返回评估内容";
  } catch (error) {
    if (error?.code === "STREAM_STOPPED" && normalizeText(test.methodReview)) {
      test.methodReview = `${normalizeText(test.methodReview)}\n\n> 已停止，以上为已经收到的部分建议。`;
    } else {
      test.methodReview = `优化失败：${String(error?.message ?? error)}`;
    }
  } finally {
    test.pending = false;
    renderWorkspace();
  }
}

function appendSkillMethodReview() {
  const test = STATE.skillTest;
  const suggestion = normalizeText(test?.methodReview);
  if (!test || !suggestion || suggestion.startsWith("优化失败：")) return;
  const current = normalizeText(test.method);
  if (current.includes(suggestion)) return showToast("该建议已加入分析方法");
  test.method = [current, `补充建议：\n${suggestion}`].filter(Boolean).join("\n\n");
  showToast("建议已加入分析方法，请确认后保存或再次测试");
  renderWorkspace();
}

async function saveSkillTestMethod({ exitAfterSave = false } = {}) {
  const test = STATE.skillTest;
  const methodToSave = normalizeText(test?.method);
  if (!test || test.pending || test.methodSaving || (test.mode !== "derived-preview" && !methodToSave)) return false;
  test.methodSaving = true;
  renderWorkspace();
  try {
    await saveSkillAnalysisMethod(test.skillId, methodToSave);
    test.savedMethod = methodToSave;
    showToast("分析方法已保存");
    if (exitAfterSave) STATE.skillTest = null;
    return true;
  } catch (error) {
    showToast(`保存失败：${String(error?.message ?? error)}`);
    return false;
  } finally {
    test.methodSaving = false;
    renderWorkspace();
  }
}

async function leaveSkillWorkspace() {
  const test = STATE.skillTest;
  if (!test || test.pending || test.methodSaving) return;
  if (test.mode === "test" && skillWorkspaceMethodDirty(test)) {
    const shouldSave = await showConfirmDialog("分析方法有修改但尚未保存，是否保存后返回？", {
      confirmText: "保存并返回",
      cancelText: "不保存，直接返回"
    });
    if (shouldSave) {
      await saveSkillTestMethod({ exitAfterSave: true });
      return;
    }
  }
  STATE.skillTest = null;
  renderWorkspace();
}

async function stopSkillExecution() {
  const test = STATE.skillTest;
  if (!test?.pending) return;
  if (test.status === "loading" && test.collectionId) {
    test.collectionStopRequested = true;
    await sendToBackground({ type: "STOP_SKILL_SOURCE_COLLECTION", collectionId: test.collectionId }).catch(() => void 0);
    if (test.collection) test.collection.phase = "stopping";
    renderWorkspace();
    return;
  }
  stopGeneration();
}

async function continueSkillConversation() {
  const test = STATE.skillTest;
  const question = normalizeText(test?.followupDraft);
  if (!test || test.pending || test.status !== "complete") return;
  if (!question) return showToast("请填写需要继续问的问题");
  const turn = { question, response: "", pending: true };
  test.followups.push(turn);
  test.followupDraft = "";
  test.pending = true;
  renderWorkspace();
  const requestMessages = [...test.conversationMessages, { role: "user", content: question }];
  try {
    await streamChat({
      messages: requestMessages,
      debugLabel: "skill-followup",
      onChunk: (delta) => {
        turn.response += delta;
        scheduleWorkspaceRender();
      }
    });
    turn.response = normalizeText(turn.response) || "模型未返回内容";
    test.conversationMessages.push(
      { role: "user", content: question },
      { role: "assistant", content: turn.response }
    );
  } catch (error) {
    turn.response = normalizeText(turn.response)
      ? `${normalizeText(turn.response)}\n\n> 回答中断：${String(error?.message ?? error)}`
      : `继续提问失败：${String(error?.message ?? error)}`;
  } finally {
    turn.pending = false;
    test.pending = false;
    renderWorkspace();
  }
}

async function chooseSkillCollectionPages(source) {
  let collectionMaxPages = 1;
  const pagination = await sendToBackground({ type: "INSPECT_SKILL_SOURCE_PAGINATION", source }).catch(() => null);
  if (pagination?.ok && pagination.data?.multiPage) {
    const knownPages = Number(pagination.data.totalPages) || 0;
    const pageDescription = knownPages > 1 ? `检测到数据源约有 ${knownPages} 页。` : "检测到数据源支持翻页。";
    while (true) {
      const value = await showPromptDialog(`${pageDescription}\n请输入需要载入的页数（0–${MAX_SKILL_COLLECTION_PAGES}），输入 0 表示全部。全部最多载入 ${MAX_SKILL_COLLECTION_PAGES} 页。`, "1", { confirmText: "开始载入" });
      if (value === null) return null;
      const parsedPages = parseSkillCollectionPageInput(value, knownPages);
      if (parsedPages !== null) {
        collectionMaxPages = parsedPages;
        break;
      }
      showToast(`请输入 0–${MAX_SKILL_COLLECTION_PAGES} 的整数页数，0 表示全部`);
    }
  }
  return collectionMaxPages;
}

async function startSkillTest(skill, { mode = "test", autoRun = false } = {}) {
  const method = buildAnalysisPrompt(skill.analysisMethod);
  if (!method) return showToast("请先配置分析方法");
  const currentPageKey = `${location.origin}${location.pathname}`;
  openSkillWorkspace({ skill, method, mode, currentPageKey });
  if (autoRun) setTimeout(() => runSkillTest(), 0);
}

function startSkillExecution(skill) {
  STATE.open = true;
  startSkillTest(skill, { mode: "execute", autoRun: false }).catch((error) => showToast(String(error?.message ?? error)));
}

function startDerivedColumnPreview(skill) {
  const currentPageKey = `${location.origin}${location.pathname}`;
  openSkillWorkspace({
    skill,
    method: String(skill?.analysisMethod?.description || ""),
    mode: "derived-preview",
    currentPageKey
  });
}

async function copySkillText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(String(text || ""));
    showToast(successMessage);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = String(text || "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.documentElement.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    showToast(copied ? successMessage : "复制失败，请手动选择内容复制");
  }
}

function downloadSkillResult(test) {
  const totalRows = (test.dataSources || []).reduce((sum, item) => sum + (item.data?.totalRowCount ?? item.data?.rowCount ?? 0), 0);
  const content = [
    `# ${test.skillName}`,
    `- ${test.mode === "execute" ? "执行" : "测试"}时间：${new Date().toLocaleString()}`,
    `- 已载入数据源：${(test.dataSources || []).filter((item) => item.data).length} 个，共 ${totalRows} 行`,
    `\n## 分析方法\n\n${normalizeText(test.method)}`,
    `\n## 实际分析结果\n\n${normalizeText(test.response)}`
  ].join("\n");
  const blobUrl = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `${test.skillName.replace(/[\\/:*?"<>|]/g, "_") || "技能测试结果"}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  showToast("Markdown 文件已下载");
}

async function uploadSkillRuntimeFiles() {
  const test = STATE.skillTest;
  if (!test || test.pending) return;
  const availableSlots = availableSkillRuntimeFileSlots(test.dataSources);
  if (!availableSlots) return showToast(`本次最多添加 ${MAX_SKILL_RUNTIME_FILES} 个临时文件数据源`);
  const files = await chooseSkillRuntimeFiles();
  if (!files.length) return;
  const { items, failures } = await loadSkillRuntimeFileSources(files, {
    availableSlots,
    chooseSheet: async (file, sheets) => {
        const answer = await showPromptDialog(
          `“${file.name}”包含 ${sheets.length} 个工作表：\n${sheets.map((sheet, index) => `${index + 1}. ${sheet.name}`).join("\n")}\n请输入工作表序号或名称。`,
          "1",
          { confirmText: "载入工作表" }
        );
        if (answer === null) return null;
        const selected = resolveSkillRuntimeSheet(sheets, answer);
        if (!selected) throw new Error("未找到选择的工作表");
        return selected;
    }
  });
  test.dataSources.push(...items);
  STATE.open = true;
  if (items.length) {
    invalidateSkillWorkspaceResult(test);
    test.activeDataSourceIndex = test.dataSources.length - 1;
  }
  renderWorkspace();
  if (failures.length) showToast(`部分文件载入失败：\n${failures.map((failure) => `${failure.fileName}：${failure.error}`).join("\n")}`, 5000, { position: "center" });
  else if (items.length) showToast(`已添加 ${items.length} 个临时文件数据源`);
}

function removeSkillRuntimeSource(index) {
  const test = STATE.skillTest;
  const item = test?.dataSources?.[index];
  if (!test || !item?.runtimeOnly || test.pending) return;
  test.dataSources.splice(index, 1);
  clampSkillWorkspaceActiveSource(test);
  invalidateSkillWorkspaceResult(test);
  renderWorkspace();
}

async function viewSkillSubmittedPrompt(test) {
  const prompt = String(test?.submittedPrompt || "");
  if (!prompt) return showToast("当前还没有已提交的内容");
  const shouldCopy = await showTextDialog("提交给大模型的完整内容", prompt, {
    message: "以下是最近一次测试或执行实际发送给模型的完整用户消息。",
    confirmText: "复制内容",
    cancelText: "关闭"
  });
  if (shouldCopy) await copySkillText(prompt, "提交内容已复制");
}

async function runDerivedColumnPreview() {
  const test = STATE.skillTest;
  if (!test || test.pending || test.mode !== "derived-preview") return;
  const sourceItem = test.dataSources?.[0];
  if (!sourceItem?.source) return showToast("请先绑定数据源");
  test.pending = true;
  test.status = "loading";
  test.error = "";
  test.response = "";
  test.submittedPrompt = "";
  test.derivedPreview = {
    headers: [],
    rows: [],
    selectedColumns: [],
    outputColumnName: "",
    uniqueRequestCount: 0,
    totalPreviewCount: 0,
    failedFingerprints: [],
    usedDefaultMethod: false
  };
  sourceItem.status = "loading";
  sourceItem.error = "";
  sourceItem.data = null;
  renderWorkspace();
  try {
    const previewResponse = await sendToBackground({
      type: "EXTRACT_SKILL_SOURCE_PREVIEW_DATA",
      source: sourceItem.source,
      limit: 20
    }).catch(() => null);
    const extracted = previewResponse?.data;
    if (!extracted?.found) throw new Error("未找到当前数据源对应的表格");
    if (extracted.status === "changed") throw new Error("数据源字段已变化，请重新选择字段");
    if (!Array.isArray(extracted.rows) || !extracted.rows.length) throw new Error("当前页没有可测试的数据");
    sourceItem.data = extracted;
    sourceItem.status = "complete";
    test.status = "submitting";
    renderWorkspace();

    const previewModel = buildDerivedPreviewRows({
      headers: extracted.headers,
      rows: extracted.rows,
      selectedColumns: test.selectedColumns,
      limit: 20
    });
    if (previewModel.resolvedSelection.missing.length) {
      throw new Error("选中的字段在当前表格中不存在，请重新选择字段");
    }
    if (!previewModel.uniqueRows.length) throw new Error("没有可用于测试的唯一字段内容");

    const settingsResponse = await sendToBackground({ type: "GET_SETTINGS", modelId: STATE.activeModelId }).catch(() => null);
    const batchSize = calculateDerivedColumnPreviewBatchSize({
      rows: previewModel.uniqueRows,
      method: test.method,
      output: test.output,
      contextWindow: settingsResponse?.data?.contextWindow,
      maxOutputTokens: settingsResponse?.data?.maxOutputTokens
    });
    const requestRows = previewModel.uniqueRows.slice(0, batchSize);
    const request = buildDerivedColumnPreviewPrompt({
      method: test.method,
      rows: requestRows,
      output: test.output,
      defaultMethodVersion: test.defaultMethodVersion
    });
    test.submittedPrompt = request.prompt;
    test.status = "analyzing";
    renderWorkspace();
    const response = await sendToBackground({
      type: "AI_CHAT",
      payload: {
        messages: [{ role: "user", content: request.prompt }],
        modelId: STATE.activeModelId,
        debugLabel: "derived-column-preview"
      }
    });
    if (!response?.ok) throw new Error(response?.error || "模型请求失败");
    const content = String(response.data?.content || "").trim();
    if (!content) throw new Error("模型没有返回内容");
    const parsed = parseDerivedColumnResults({
      text: content,
      expectedFingerprints: requestRows.map((row) => row.fingerprint),
      output: test.output
    });
    const resultMap = parsed.resultMap;
    const selectedHeaders = previewModel.resolvedSelection.columns.map((column) => column.displayHeader || column.header);
    const outputColumnName = test.output?.columnName || "智能分析结论";
    test.response = content;
    test.derivedPreview = {
      headers: [...selectedHeaders, outputColumnName],
      selectedColumns: previewModel.resolvedSelection.columns,
      rows: previewModel.previewRows.map((row) => {
        const matched = resultMap.get(row.fingerprint);
        const failure = parsed.failures.find((item) => item.fingerprint === row.fingerprint);
        return {
          fingerprint: row.fingerprint,
          selectedValues: row.selectedValues,
          conclusion: matched?.conclusion || "",
          status: matched ? "complete" : failure ? "error" : "pending",
          error: failure?.error || ""
        };
      }),
      outputColumnName,
      uniqueRequestCount: requestRows.length,
      totalPreviewCount: previewModel.previewRows.length,
      failedFingerprints: parsed.failures,
      usedDefaultMethod: request.usedDefaultMethod
    };
    test.status = parsed.failures.length ? "complete" : "complete";
    test.attempts += 1;
  } catch (error) {
    sourceItem.status = "error";
    sourceItem.error = String(error?.message ?? error);
    test.error = sourceItem.error;
    test.status = "error";
  } finally {
    test.pending = false;
    renderWorkspace();
  }
}

/**
 * 执行技能测试/正式运行的共享主干。
 *
 * 不可破坏的三个不变量：
 * 1. 测试只有在当前全屏会话的全部数据源已完整载入时才复用缓存；执行默认重新采集。
 * 2. 任一持久化网页数据源失败或被停止，都不得向模型提交部分数据。
 * 3. 扩展自动打开的 Tab 只能在 item.data 已写入会话后 finalize/关闭。
 * 运行时上传文件仅属于当前会话，不参与网页重新采集和技能持久化。
 */
async function runSkillTest({ reuseData = false } = {}) {
  const test = STATE.skillTest;
  if (!test || test.pending) return;
  if (!normalizeText(test.method)) return showToast("请填写分析方法");
  const dataSources = test.dataSources || [];
  const hasAllSourceData = skillWorkspaceHasAllSourceData(test);
  const shouldLoadData = test.mode === "execute" ? !reuseData : !hasAllSourceData;
  test.pending = true;
  test.status = shouldLoadData ? "loading" : "submitting";
  test.response = "";
  test.submittedPrompt = "";
  test.resultTab = "result";
  test.error = "";
  if (shouldLoadData) {
    test.collectionStopRequested = false;
    test.structureUpdateDeclined = false;
    test.data = null;
    for (const item of dataSources) {
      if (item.runtimeOnly) {
        item.status = "complete";
        item.error = "";
        item.previewPage = 1;
        continue;
      }
      item.status = "ready";
      item.data = null;
      item.error = "";
      item.collectionId = "";
      item.collection = null;
      item.previewPage = 1;
    }
  }
  renderWorkspace();
  try {
    if (shouldLoadData) {
      for (let index = 0; index < dataSources.length; index++) {
        const item = dataSources[index];
        if (item.runtimeOnly) continue;
        item.status = "loading";
        test.activeDataSourceIndex = index;
        renderWorkspace();
        const collectionMaxPages = await chooseSkillCollectionPages(item.source);
        if (collectionMaxPages === null) {
          await sendToBackground({ type: "CLOSE_AUTO_OPENED_SKILL_PAGE", source: item.source }).catch(() => null);
          cancelSkillWorkspaceCollectionPageSelection(test, item);
          STATE.open = true;
          refs.suppressPanelCloseUntil = Date.now() + 1200;
          if (refs.panelCloseTimer) clearTimeout(refs.panelCloseTimer);
          refs.panelCloseTimer = null;
          showToast("已取消数据源载入，本次未提交给模型");
          return;
        }
        item.collectionMaxPages = collectionMaxPages;
        item.collectionId = uid();
        item.collection = { phase: "locating", pages: 0, rowCount: 0, maxPages: item.collectionMaxPages || 1, maxRows: MAX_SKILL_COLLECTION_ROWS };
        test.collectionId = item.collectionId;
        test.collection = item.collection;
        renderWorkspace();
        try {
          let loaded = await sendToBackground({
            type: "LOAD_SKILL_SOURCE_DATA",
            source: item.source,
            collectionId: item.collectionId,
            maxPages: item.collectionMaxPages || 1,
            maxRows: MAX_SKILL_COLLECTION_ROWS
          });
          if (!loaded?.ok && loaded?.code === "SOURCE_STRUCTURE_CHANGED") {
            const accepted = await showConfirmDialog(
              `数据源“${item.name}”的字段结构已经更新，是否使用新结构更新技能并继续获取数据？`,
              { confirmText: "更新并继续", cancelText: "不更新，停止获取" }
            );
            if (!accepted) {
              await sendToBackground({ type: "CLOSE_AUTO_OPENED_SKILL_PAGE", source: item.source }).catch(() => null);
              test.structureUpdateDeclined = true;
              test.collectionStopRequested = true;
              throw new Error("用户取消更新数据源结构");
            }
            const updatedSource = await updateSkillSourceHeaders(test.skillId, item.source.id, loaded.headers);
            item.source.headers = [...updatedSource.headers];
            item.source.capturedAt = updatedSource.capturedAt;
            loaded = await sendToBackground({
              type: "LOAD_SKILL_SOURCE_DATA",
              source: item.source,
              collectionId: item.collectionId,
              maxPages: item.collectionMaxPages || 1,
              maxRows: MAX_SKILL_COLLECTION_ROWS
            });
          }
          if (!loaded?.ok) throw new Error(loaded?.error || "数据源载入失败");
          item.data = loaded.data;
          if (loaded.data?.completeForRequest === false) {
            const reason = loaded.data.collectionReason || "incomplete";
            const reasonLabels = {
              stopped: "用户已停止采集",
              "page-timeout": "翻页结果无法确认",
              "next-click-failed": "下一页操作失败"
            };
            item.status = "incomplete";
            item.error = reasonLabels[reason] || `采集未完整结束（${reason}）`;
          } else {
            item.status = "complete";
          }
          if (loaded.requiresFinalize) {
            // item.data 和状态已经写入测试/执行会话；此确认到达后台后，才
            // 允许切回原页面及关闭扩展自动创建的浏览器 Tab。
            await sendToBackground({
              type: "FINALIZE_SKILL_SOURCE_COLLECTION",
              sourceTabId: loaded.sourceTabId,
              collectionId: item.collectionId
            }).catch(() => null);
          }
        } catch (error) {
          item.error = String(error?.message ?? error);
          item.status = "error";
        }
        if (test.collectionStopRequested) break;
      }
      test.collectionId = "";
      test.collection = null;
      const firstLoadedIndex = dataSources.findIndex((item) => item.data);
      test.data = firstLoadedIndex >= 0 ? dataSources[firstLoadedIndex].data : null;
      if (firstLoadedIndex >= 0) test.activeDataSourceIndex = firstLoadedIndex;
      test.previewPage = 1;
      if (test.returnBusinessTabTitle) {
        await sendToBackground({
          type: "ACTIVATE_SKILL_BUSINESS_TAB",
          title: test.returnBusinessTabTitle
        }).catch(() => null);
      }
      if (test.structureUpdateDeclined) throw new Error("数据源结构未更新，本次数据获取已终止");
      const incompleteSources = incompleteSkillDataSources(dataSources);
      if (incompleteSources.length) {
        const names = incompleteSources.map((item) => item.name).join("、");
        throw new Error(`以下数据源未完成载入：${names}。为避免使用不完整数据，本次未提交给模型`);
      }
    }
    test.status = "submitting";
    renderWorkspace();
    const settingsResponse = await sendToBackground({ type: "GET_SETTINGS", modelId: STATE.activeModelId }).catch(() => null);
    const requestBudget = calculateSkillRequestBudget({
      contextWindow: settingsResponse?.data?.contextWindow,
      maxOutputTokens: settingsResponse?.data?.maxOutputTokens,
      method: test.method
    });
    const prompt = buildSkillRequestPrompt({ method: test.method, dataSources }, requestBudget.maxChars);
    // 保存实际发送的文本快照；查看时不能重新组装，否则后续编辑会让
    // 展示内容与本次真实请求不一致。
    test.submittedPrompt = prompt;
    DEBUG && console.info("[web2ai.ai.request] skill-test prepared", JSON.stringify({
      modelId: STATE.activeModelId,
      sourceCount: dataSources.length,
      loadedSourceCount: dataSources.filter((item) => item.data).length,
      failedSourceCount: dataSources.filter((item) => item.error).length,
      submittedRowCount: dataSources.reduce((sum, item) => sum + (item.data?.rowCount || 0), 0),
      reusedData: !shouldLoadData,
      analysisMethodLength: normalizeText(test.method).length,
      promptLength: prompt.length,
      requestBudgetChars: requestBudget.maxChars
    }));
    test.status = "analyzing";
    test.conversationMessages = [{ role: "user", content: prompt }];
    test.followups = [];
    test.methodReview = "";
    renderWorkspace();
    await streamChat({
      messages: [{ role: "user", content: prompt }],
      debugLabel: test.mode === "execute" ? "skill-execution" : "skill-test",
      onChunk: (delta) => {
        test.response += delta;
        scheduleWorkspaceRender();
      }
    });
    test.response = normalizeText(test.response) || "模型未返回内容";
    test.conversationMessages.push({ role: "assistant", content: test.response });
    test.status = "complete";
    test.attempts += 1;
  } catch (error) {
    if (shouldLoadData && test.returnBusinessTabTitle) {
      // 采集失败或用户取消时也只在当前采集调用结束后恢复原内部页面。
      await sendToBackground({
        type: "ACTIVATE_SKILL_BUSINESS_TAB",
        title: test.returnBusinessTabTitle
      }).catch(() => null);
    }
    if (error?.code === "STREAM_STOPPED") {
      if (normalizeText(test.response)) {
        test.response = `${normalizeText(test.response)}\n\n> 已由用户停止，以上为已经收到的部分结果。`;
        test.status = "complete";
      } else {
        test.status = "ready";
        showToast("已停止测试");
      }
    } else if (normalizeText(test.response)) {
      test.response = `${normalizeText(test.response)}\n\n> 连接中断，以上为已经收到的部分结果。可以点击“再次测试”重新执行。`;
      test.status = "complete";
      test.attempts += 1;
    } else {
      test.error = String(error?.message ?? error);
      test.status = "error";
    }
  } finally {
    test.pending = false;
    renderWorkspace();
  }
}


export {
  applySkillWorkspaceCollectionProgress,
  appendSkillMethodReview,
  continueSkillConversation,
  copySkillText,
  downloadSkillResult,
  initSkillWorkspaceController,
  leaveSkillWorkspace,
  openSkillWorkspace,
  removeSkillRuntimeSource,
  reviewSkillAnalysisMethod,
  runDerivedColumnPreview,
  runSkillTest,
  saveSkillTestMethod,
  startDerivedColumnPreview,
  startSkillExecution,
  startSkillTest,
  uploadSkillRuntimeFiles,
  viewSkillSubmittedPrompt,
  stopSkillExecution
};
