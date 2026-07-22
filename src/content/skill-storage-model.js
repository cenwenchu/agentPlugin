/**
 * @fileoverview 技能存储 mutation 的纯数据模型。
 *
 * Chrome Storage 不提供 compare-and-swap。background 使用本模块在单一队列中
 * 串行执行 mutation；内容脚本仍可直接读取原有 web2aiSkills 数组，保持旧数据、
 * 导入导出和 storage.onChanged 的兼容性。
 */

import { skillContentFingerprint } from "./skill-import-model.js";

class SkillMutationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillMutationError";
    this.code = code;
  }
}

function revisionOf(skill) {
  return Math.max(0, Number(skill?.revision) || 0);
}

function requireSkill(skills, skillId) {
  const index = skills.findIndex((skill) => skill?.id === skillId);
  if (index < 0) throw new SkillMutationError("SKILL_NOT_FOUND", "技能不存在或已被删除");
  return { index, skill: skills[index] };
}

function assertRevision(skill, expectedRevision) {
  if (expectedRevision == null) return;
  if (revisionOf(skill) !== Math.max(0, Number(expectedRevision) || 0)) {
    throw new SkillMutationError("SKILL_CONFLICT", "技能已被其他页面修改，请重新打开后再编辑");
  }
}

function withNextRevision(skill, now) {
  return { ...skill, revision: revisionOf(skill) + 1, updatedAt: now };
}

function applySkillMutation({ skills = [], pageNames = {} } = {}, mutation = {}) {
  const nextSkills = Array.isArray(skills) ? [...skills] : [];
  let nextPageNames = pageNames && typeof pageNames === "object" && !Array.isArray(pageNames) ? { ...pageNames } : {};
  const now = Math.max(1, Number(mutation.now) || Date.now());
  let result = null;

  if (mutation.type === "UPSERT_SKILL") {
    const incoming = mutation.skill;
    if (!incoming?.id) throw new SkillMutationError("INVALID_SKILL", "技能数据无效");
    const index = nextSkills.findIndex((skill) => skill?.id === incoming.id);
    if (index >= 0) {
      assertRevision(nextSkills[index], mutation.expectedRevision);
      const existingSources = new Map((nextSkills[index].sources || []).map((source) => [source?.id, source]));
      const mergedSources = (incoming.sources || []).map((source) => {
        const existingSource = existingSources.get(source?.id);
        if (!existingSource?.businessTabTitle || source?.businessTabTitle) return source;
        return {
          ...source,
          businessTabTitle: existingSource.businessTabTitle,
          businessTabTitleConfirmed: existingSource.businessTabTitleConfirmed === true
        };
      });
      result = withNextRevision({
        ...incoming,
        sources: mergedSources,
        source: mergedSources[0] || incoming.source || null,
        createdAt: nextSkills[index].createdAt || incoming.createdAt || now
      }, now);
      nextSkills[index] = result;
    } else {
      if (Math.max(0, Number(mutation.expectedRevision) || 0) > 0) {
        throw new SkillMutationError("SKILL_CONFLICT", "技能已被删除，请重新创建");
      }
      result = { ...incoming, revision: 1, createdAt: incoming.createdAt || now, updatedAt: now };
      nextSkills.unshift(result);
    }
  } else if (mutation.type === "UPDATE_ANALYSIS_METHOD") {
    const target = requireSkill(nextSkills, mutation.skillId);
    assertRevision(target.skill, mutation.expectedRevision);
    result = withNextRevision({ ...target.skill, analysisMethod: mutation.analysisMethod }, now);
    nextSkills[target.index] = result;
  } else if (mutation.type === "UPDATE_SOURCE_HEADERS") {
    const target = requireSkill(nextSkills, mutation.skillId);
    assertRevision(target.skill, mutation.expectedRevision);
    const sources = (target.skill.sources || []).map((source) => source?.id === mutation.sourceId
      ? { ...source, headers: [...(mutation.headers || [])], capturedAt: now }
      : source);
    if (!sources.some((source) => source?.id === mutation.sourceId)) {
      throw new SkillMutationError("SOURCE_NOT_FOUND", "未找到需要更新的数据源");
    }
    result = withNextRevision({ ...target.skill, sources, source: sources[0] || null }, now);
    nextSkills[target.index] = result;
  } else if (mutation.type === "LEARN_SOURCE_BUSINESS_TAB") {
    const target = requireSkill(nextSkills, mutation.skillId);
    const current = (target.skill.sources || []).find((source) => source?.id === mutation.sourceId);
    if (!current) throw new SkillMutationError("SOURCE_NOT_FOUND", "未找到需要更新的数据源");
    const learnedTitle = String(mutation.title || "").trim();
    if (!learnedTitle) throw new SkillMutationError("INVALID_BUSINESS_TAB", "业务页签名称不能为空");
    // 兼容历史绑定时只填空值。已有标题只能在用户明确重新绑定时由 UPSERT 覆盖。
    if (current.businessTabTitle) {
      result = target.skill;
    } else {
      const sources = target.skill.sources.map((source) => source?.id === mutation.sourceId
        ? { ...source, businessTabTitle: learnedTitle, businessTabTitleConfirmed: true }
        : source);
      // 这是只填空值的兼容迁移，不代表用户编辑，不递增 revision；否则用户
      // 恰好打开旧技能编辑时会被本页面自己的迁移误判为并发冲突。
      result = { ...target.skill, sources, source: sources[0] || null };
      nextSkills[target.index] = result;
    }
  } else if (mutation.type === "DELETE_SKILL") {
    const target = requireSkill(nextSkills, mutation.skillId);
    assertRevision(target.skill, mutation.expectedRevision);
    nextSkills.splice(target.index, 1);
    result = { deletedId: mutation.skillId };
  } else if (mutation.type === "IMPORT_SKILLS") {
    const seen = new Set(nextSkills.map(skillContentFingerprint));
    let added = 0;
    for (const skill of mutation.skills || []) {
      const fingerprint = skillContentFingerprint(skill);
      if (!skill?.id || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      nextSkills.push({ ...skill, revision: Math.max(1, revisionOf(skill)), createdAt: skill.createdAt || now, updatedAt: now });
      added++;
    }
    nextPageNames = { ...nextPageNames, ...(mutation.pageNames || {}) };
    result = { added };
  } else if (mutation.type === "SET_PAGE_NAME") {
    if (!mutation.pageKey || !String(mutation.name || "").trim()) {
      throw new SkillMutationError("INVALID_PAGE_NAME", "页面名称不能为空");
    }
    nextPageNames[mutation.pageKey] = String(mutation.name).trim();
    result = { pageKey: mutation.pageKey, name: nextPageNames[mutation.pageKey] };
  } else if (mutation.type === "DELETE_ALL_SKILLS") {
    nextSkills.length = 0;
    nextPageNames = {};
    result = { deletedAll: true };
  } else {
    throw new SkillMutationError("UNKNOWN_SKILL_MUTATION", "未知的技能存储操作");
  }

  return { skills: nextSkills, pageNames: nextPageNames, result };
}

export { SkillMutationError, applySkillMutation, revisionOf };
