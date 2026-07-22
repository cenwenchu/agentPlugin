/**
 * @fileoverview 持久化技能数据源的增量身份模型。
 *
 * locatorVersion=2 的新绑定记录 frame 层级提示和组件特征。提示只用于缩小
 * 候选或报告歧义，不会根据表头/标题评分自动换绑；旧绑定继续使用原有
 * frameUrl + selector + tableIndex 兼容路径。
 */

const SOURCE_LOCATOR_VERSION = 2;

function normalizeFramePath(path = []) {
  return (Array.isArray(path) ? path : []).map((segment) => ({
    url: String(segment?.url || ""),
    sameUrlIndex: Math.max(0, Number(segment?.sameUrlIndex) || 0)
  }));
}

function framePathSignature(path = []) {
  return normalizeFramePath(path).map((segment) => `${segment.url}#${segment.sameUrlIndex}`).join(" > ");
}

function buildFramePathHint(frames = [], frameId = 0, normalizeUrl = (value) => String(value || "")) {
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const path = [];
  let current = byId.get(frameId);
  const visited = new Set();
  while (current && !visited.has(current.frameId)) {
    visited.add(current.frameId);
    const url = normalizeUrl(current.url || "");
    const siblings = frames
      .filter((frame) => frame.parentFrameId === current.parentFrameId && normalizeUrl(frame.url || "") === url)
      .sort((left, right) => left.frameId - right.frameId);
    path.unshift({ url, sameUrlIndex: Math.max(0, siblings.findIndex((frame) => frame.frameId === current.frameId)) });
    if (current.frameId === 0 || current.parentFrameId == null || current.parentFrameId < 0) break;
    current = byId.get(current.parentFrameId);
  }
  return path;
}

function chooseSourceTableCandidate({ locatorVersion = 0, selectorCandidates = [], indexedCandidate = null, selectorStrength = "" } = {}) {
  const uniqueSelectorCandidates = [...new Set((selectorCandidates || []).filter(Boolean))];
  if (Number(locatorVersion) >= SOURCE_LOCATOR_VERSION && uniqueSelectorCandidates.length > 1) {
    return { candidate: null, ambiguous: true, matchMethod: "conflicting-table-locators" };
  }
  if (Number(locatorVersion) >= SOURCE_LOCATOR_VERSION && uniqueSelectorCandidates[0] && indexedCandidate &&
      uniqueSelectorCandidates[0] !== indexedCandidate && selectorStrength !== "stable-id") {
    return { candidate: null, ambiguous: true, matchMethod: "conflicting-table-locators" };
  }
  return {
    candidate: uniqueSelectorCandidates[0] || indexedCandidate || null,
    ambiguous: false,
    matchMethod: uniqueSelectorCandidates[0]
      ? selectorStrength === "stable-id" ? "stable-selector" : "selector"
      : indexedCandidate ? "tableIndex" : "none"
  };
}

/**
 * 新绑定若能精确恢复 framePath，只向该 frame 发送定位请求。同 URL 下有多个
 * frame 而路径提示无法唯一确认时返回 ambiguous，避免退化成“第一个相似表”。
 */
function selectSourceFrames(frames = [], source = {}, normalizeUrl = (value) => String(value || "")) {
  const preferredUrl = normalizeUrl(source.frameUrl || "");
  const legacyOrdered = [...frames].sort((left, right) => (
    Number(normalizeUrl(right.url || "") === preferredUrl) - Number(normalizeUrl(left.url || "") === preferredUrl)
  ));
  if (Number(source.locatorVersion) < SOURCE_LOCATOR_VERSION || !source.framePathHint?.length) {
    return { frames: legacyOrdered, ambiguous: false, matchMethod: "legacy-frame-url" };
  }
  const expected = framePathSignature(source.framePathHint);
  const exact = frames.filter((frame) => framePathSignature(
    buildFramePathHint(frames, frame.frameId, normalizeUrl)
  ) === expected);
  if (exact.length === 1) return { frames: exact, ambiguous: false, matchMethod: "frame-path" };
  if (exact.length > 1) return { frames: [], ambiguous: true, matchMethod: "frame-path-duplicate" };
  const sameUrl = frames.filter((frame) => normalizeUrl(frame.url || "") === preferredUrl);
  if (sameUrl.length === 1) {
    // iframe 的装载顺序可能变化；当 URL 本身仍唯一时保留兼容兜底。
    return { frames: sameUrl, ambiguous: false, matchMethod: "unique-frame-url-fallback" };
  }
  if (sameUrl.length > 1) return { frames: [], ambiguous: true, matchMethod: "same-url-frames" };
  return { frames: legacyOrdered, ambiguous: false, matchMethod: "legacy-no-url-match" };
}

export {
  SOURCE_LOCATOR_VERSION,
  buildFramePathHint,
  chooseSourceTableCandidate,
  framePathSignature,
  normalizeFramePath,
  selectSourceFrames
};
