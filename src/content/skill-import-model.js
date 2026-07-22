/**
 * @fileoverview 技能导入的内容去重规则。
 * 技能名称、ID 和时间不代表业务能力；只有数据源绑定与分析方法参与判断。
 */

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

function skillContentFingerprint(skill = {}) {
  const sources = Array.isArray(skill.sources) && skill.sources.length
    ? skill.sources
    : [skill.source].filter(Boolean);
  return JSON.stringify({
    sources: sources.map(sourceIdentity),
    analysisMethod: analysisDescription(skill.analysisMethod)
  });
}

export { skillContentFingerprint };
