/**
 * @fileoverview 技能导入的内容去重规则。
 * 技能名称、ID 和时间不代表业务能力；只有数据源绑定与分析方法参与判断。
 */

import {
  DEFAULT_DERIVED_METHOD_VERSION,
  normalizeDerivedColumnOutput,
  normalizeDerivedColumnSelections,
  skillTypeOf
} from "./derived-column-model.js";

function normalizedHeader(value) {
  return String(value ?? "").replace(/\s+/g, "").trim().toLowerCase();
}

function analysisDescription(method) {
  if (typeof method === "string") return method.trim();
  return String(method?.description || "").replace(/\r\n?/g, "\n").trim();
}

function sourceIdentity(source = {}) {
  return {
    locatorVersion: Math.max(0, Number(source.locatorVersion) || 0),
    pageKey: String(source.pageKey || "").trim(),
    frameUrl: String(source.frameUrl || "").trim(),
    isTopFrame: Boolean(source.isTopFrame),
    selector: String(source.selector || "").trim(),
    selectorStrength: String(source.selectorStrength || "").trim(),
    tableIndex: Number.isInteger(source.tableIndex) ? source.tableIndex : null,
    framePathHint: Array.isArray(source.framePathHint) ? source.framePathHint.map((segment) => ({
      url: String(segment?.url || "").trim(),
      sameUrlIndex: Math.max(0, Number(segment?.sameUrlIndex) || 0)
    })) : [],
    componentType: String(source.componentType || "").trim(),
    containerSignature: String(source.containerSignature || "").trim(),
    headers: Array.isArray(source.headers) ? source.headers.map(normalizedHeader) : []
  };
}

function tableAnalysisFingerprint(skill = {}) {
  const sources = Array.isArray(skill.sources) && skill.sources.length
    ? skill.sources
    : [skill.source].filter(Boolean);
  return JSON.stringify({
    sources: sources.map(sourceIdentity),
    analysisMethod: analysisDescription(skill.analysisMethod)
  });
}

function derivedColumnFingerprint(skill = {}) {
  const sources = Array.isArray(skill.sources) && skill.sources.length
    ? skill.sources
    : [skill.source].filter(Boolean);
  const method = analysisDescription(skill.analysisMethod);
  const output = normalizeDerivedColumnOutput(skill.output);
  return JSON.stringify({
    type: "derived-column",
    sources: sources.map(sourceIdentity),
    selectedColumns: normalizeDerivedColumnSelections(skill.selectedColumns).map((column) => ({
      normalizedHeader: column.normalizedHeader,
      occurrence: column.occurrence
    })),
    analysisMethod: method,
    defaultMethodVersion: method ? null : Math.max(1, Number(skill.defaultMethodVersion) || DEFAULT_DERIVED_METHOD_VERSION),
    output: {
      columnName: output.columnName,
      position: output.position,
      maxChars: output.maxChars
    }
  });
}

function skillContentFingerprint(skill = {}) {
  return skillTypeOf(skill) === "derived-column"
    ? derivedColumnFingerprint(skill)
    : tableAnalysisFingerprint(skill);
}

export { skillContentFingerprint };
