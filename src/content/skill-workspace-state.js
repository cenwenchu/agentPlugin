/**
 * @fileoverview 技能测试/执行工作台的纯状态模型。
 *
 * 本模块不访问 DOM、Chrome API 或全局 STATE，并保持外部
 * `STATE.skillTest` 的兼容字段结构。会话创建、结果失效、进度更新和
 * 展示文案等纯状态规则集中在这里，由 controller/view 共同复用。
 */

function normalizedWorkspaceText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createSkillWorkspaceSession({ skill = {}, method = "", mode = "test", currentPageKey = "" } = {}) {
  const sources = (skill.sources?.length ? skill.sources : [skill.source]).filter(Boolean);
  return {
    skillId: skill.id,
    skillName: skill.name,
    skillType: skill.type || "table-analysis",
    selectedColumns: Array.isArray(skill.selectedColumns) ? [...skill.selectedColumns] : [],
    output: skill.output ? { ...skill.output } : null,
    defaultMethodVersion: skill.defaultMethodVersion || 1,
    sourceName: skill.sourceName,
    source: skill.source,
    sources,
    returnBusinessTabTitle: sources.find((source) => source.pageKey === currentPageKey)?.businessTabTitle || "",
    mode: mode === "execute" ? "execute" : mode === "derived-preview" ? "derived-preview" : "test",
    method,
    savedMethod: method,
    data: null,
    status: "ready",
    response: "",
    submittedPrompt: "",
    methodReview: "",
    error: "",
    pending: false,
    methodSaving: false,
    attempts: 0,
    collectionId: "",
    collection: null,
    collectionMaxPages: 1,
    collectionStopRequested: false,
    structureUpdateDeclined: false,
    dataSources: sources.map((source, index) => ({
      source,
      runtimeOnly: false,
      sourceType: "web",
      name: source.displayName || source.pageTitle || `数据源 ${index + 1}`,
      status: "ready",
      data: null,
      error: "",
      collectionId: "",
      collection: null,
      collectionMaxPages: 1,
      previewPage: 1
    })),
    activeDataSourceIndex: 0,
    conversationMessages: [],
    followups: [],
    followupDraft: "",
    resultTab: "result",
    previewPage: 1,
    derivedPreview: {
      headers: [],
      rows: [],
      selectedColumns: [],
      outputColumnName: "",
      uniqueRequestCount: 0,
      totalPreviewCount: 0,
      failedFingerprints: [],
      usedDefaultMethod: false
    }
  };
}

function invalidateSkillWorkspaceResult(session) {
  if (!session) return session;
  session.response = "";
  session.error = "";
  session.status = "ready";
  session.attempts = 0;
  session.conversationMessages = [];
  session.followups = [];
  session.followupDraft = "";
  session.methodReview = "";
  session.submittedPrompt = "";
  session.resultTab = "result";
  session.derivedPreview = {
    headers: [],
    rows: [],
    selectedColumns: [],
    outputColumnName: "",
    uniqueRequestCount: 0,
    totalPreviewCount: 0,
    failedFingerprints: [],
    usedDefaultMethod: false
  };
  return session;
}

function clampSkillWorkspaceActiveSource(session) {
  if (!session) return 0;
  const max = Math.max(0, (session.dataSources?.length || 0) - 1);
  const value = Number(session.activeDataSourceIndex);
  session.activeDataSourceIndex = Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.trunc(value)))
    : 0;
  return session.activeDataSourceIndex;
}

function skillWorkspaceHasAllSourceData(session) {
  const sources = session?.dataSources || [];
  return Boolean(sources.length) && sources.every((item) => item?.data);
}

function skillWorkspaceMethodDirty(session) {
  return normalizedWorkspaceText(session?.method) !== normalizedWorkspaceText(session?.savedMethod);
}

/**
 * 返回分析结果框在异步阶段展示的统一文案。
 * loading 只代表网页数据仍在采集；请求开始组装后进入 submitting，
 * 发出请求并等待/接收首段内容时进入 analyzing，两者都不得再显示采集中。
 */
function skillWorkspaceResultStatusMessage(session) {
  if (session?.status === "loading") return "正在采集数据...";
  if (session?.status === "submitting" || session?.status === "analyzing") {
    return "已经提交给大模型，正在等待模型返回...";
  }
  return session?.pending ? "正在处理..." : "";
}

function updateSkillWorkspaceCollectionProgress(session, collectionId, progress) {
  if (!session || !collectionId) return false;
  const item = session.dataSources?.find((candidate) => candidate.collectionId === collectionId);
  if (!item && session.collectionId !== collectionId) return false;
  if (item) item.collection = progress || null;
  session.collection = progress || null;
  return true;
}

function cancelSkillWorkspaceCollectionPageSelection(session, item) {
  if (!session || !item) return false;
  item.status = "ready";
  item.error = "";
  item.collectionId = "";
  item.collection = null;
  session.collectionId = "";
  session.collection = null;
  session.collectionStopRequested = false;
  session.error = "已取消数据源载入，本次未提交给模型。可以重新开始。";
  session.status = "error";
  return true;
}

function selectSkillWorkspacePreview(item, pageSize = 10) {
  const rows = Array.isArray(item?.data?.rows) ? item.data.rows : [];
  const size = Math.max(1, Math.trunc(Number(pageSize) || 10));
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const requested = Math.trunc(Number(item?.previewPage) || 1);
  const page = Math.min(pageCount, Math.max(1, requested));
  return {
    rows,
    page,
    pageCount,
    pageRows: rows.slice((page - 1) * size, page * size)
  };
}

export {
  cancelSkillWorkspaceCollectionPageSelection,
  clampSkillWorkspaceActiveSource,
  createSkillWorkspaceSession,
  invalidateSkillWorkspaceResult,
  normalizedWorkspaceText,
  selectSkillWorkspacePreview,
  skillWorkspaceHasAllSourceData,
  skillWorkspaceMethodDirty,
  skillWorkspaceResultStatusMessage,
  updateSkillWorkspaceCollectionProgress
};
