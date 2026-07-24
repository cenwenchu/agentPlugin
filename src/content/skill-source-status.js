const SKILL_SOURCE_STATUS_LABELS = {
  checking: "校验中",
  available: "可用",
  deferred: "执行时校验",
  changed: "数据源已变化",
  ambiguous: "数据源位置不明确",
  missing: "数据源失效"
};

const TEST_BLOCKING_SKILL_SOURCE_STATUSES = new Set(["checking", "changed", "ambiguous", "missing"]);
const DRAFT_REUSABLE_SKILL_SOURCE_STATUSES = new Set(["available", "deferred"]);

function skillSourceStatusLabel(detail = {}) {
  const status = String(detail?.status || "checking");
  return SKILL_SOURCE_STATUS_LABELS[status] || status || "校验中";
}

function isSkillSourceUnavailableForTest(detail = {}) {
  return TEST_BLOCKING_SKILL_SOURCE_STATUSES.has(String(detail?.status || "checking"));
}

function isSkillSourceReusableForDraft(detail = {}) {
  return DRAFT_REUSABLE_SKILL_SOURCE_STATUSES.has(String(detail?.status || "checking"));
}

function collectSkillUnavailableSources(skill = {}, sourceStatuses = {}) {
  const sources = (Array.isArray(skill?.sources) && skill.sources.length ? skill.sources : [skill?.source]).filter(Boolean);
  return sources
    .map((source, index) => ({ source, index, detail: sourceStatuses[source.id] || { status: "checking" } }))
    .filter((item) => isSkillSourceUnavailableForTest(item.detail));
}

function buildSkillSourceRecoveryHint(skill = {}, sourceStatuses = {}) {
  const unavailable = collectSkillUnavailableSources(skill, sourceStatuses);
  if (!unavailable.length) return "";
  const statuses = new Set(unavailable.map((item) => String(item.detail?.status || "checking")));
  if (statuses.has("changed")) {
    return "若多个业务 Tab 共用同一张表，可先切换到正确的 Tab 再重新打开 Chat 更新状态；若表结构已更新，请点击“修改技能”重新选择数据源。";
  }
  if (statuses.has("ambiguous")) {
    return "当前命中了多个可能位置，请点击“修改技能”重新选择更明确的数据源。";
  }
  if (statuses.has("missing")) {
    return "当前页面未找到原数据源，请点击“修改技能”重新选择数据源。";
  }
  if (statuses.has("checking")) {
    return "页面仍在校验数据源，请稍后再试。";
  }
  return "";
}

function buildSkillTestUnavailableMessage(skill = {}, sourceStatuses = {}) {
  const unavailable = collectSkillUnavailableSources(skill, sourceStatuses);
  if (!unavailable.length) return "";
  const names = unavailable
    .map((item) => item.source.displayName || `数据源 ${item.index + 1}`)
    .join("、");
  const labels = [...new Set(unavailable.map((item) => skillSourceStatusLabel(item.detail)))].join("、");
  const recoveryHint = buildSkillSourceRecoveryHint(skill, sourceStatuses);
  return `当前数据源状态不可用（${labels}）：${names}，暂时不可测试。${recoveryHint || "请稍后再试。"}`;
}

export {
  buildSkillSourceRecoveryHint,
  DRAFT_REUSABLE_SKILL_SOURCE_STATUSES,
  SKILL_SOURCE_STATUS_LABELS,
  buildSkillTestUnavailableMessage,
  collectSkillUnavailableSources,
  isSkillSourceReusableForDraft,
  isSkillSourceUnavailableForTest,
  skillSourceStatusLabel
};
