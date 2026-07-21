/**
 * @fileoverview 技能数据采集的纯计算规则。
 *
 * DOM 定位和滚动副作用保留在 skills.js；本模块只判断虚拟化特征并计算
 * 下一次滚动位置，便于用 Node 单元测试覆盖边界条件。
 */

/** 测试和执行共用的单数据源采集上限，避免 UI/background/frame 配置漂移。 */
const MAX_SKILL_COLLECTION_PAGES = 30;
const MAX_SKILL_COLLECTION_ROWS = 1000;

/**
 * 判断滚动区域是否很可能只渲染了部分数据行。
 * 框架明确包含 virtual 类名时直接命中；否则用滚动总高度与当前 DOM 行
 * 高度之差判断是否存在未渲染的占位空间。
 */
function classifyScrollCollection({
  className = "", scrollHeight = 0, clientHeight = 0, renderedRowHeights = [],
  isDocumentScroller = false, hasVirtualLayoutEvidence = false
} = {}) {
  const totalHeight = Math.max(0, Number(scrollHeight) || 0);
  const viewportHeight = Math.max(0, Number(clientHeight) || 0);
  const hasScrollRange = totalHeight - viewportHeight > 8;
  const hasRenderedRows = renderedRowHeights.some((height) => (Number(height) || 0) > 0);
  if (!hasScrollRange || !hasRenderedRows) return "none";
  if (/(virtual-list|virtual-scroll|virtualized)/i.test(String(className)) || hasVirtualLayoutEvidence) return "confirmed";
  // 整个网页很长，并不代表其中的数据源需要滚动。文档级滚动必须有明确的
  // 虚拟布局证据，避免把页面导航、页脚等高度误认为未渲染数据。
  if (isDocumentScroller) return "none";
  const renderedHeight = renderedRowHeights.reduce((sum, height) => sum + Math.max(0, Number(height) || 0), 0);
  return totalHeight > renderedHeight + Math.max(80, viewportHeight * 0.5) ? "probe" : "none";
}

function isVirtualScrollMetrics(metrics = {}) {
  return classifyScrollCollection(metrics) !== "none";
}

/**
 * 连续滚动后没有发现新行，说明容器很可能被误判，或页面数据已经采完。
 * 保留一次空步容忍重叠窗口和短暂渲染抖动，第二次空步立即停止。
 */
function shouldStopAfterNoProgress(consecutiveEmptySteps, limit = 2) {
  return Math.max(0, Number(consecutiveEmptySteps) || 0) >= Math.max(1, Number(limit) || 2);
}

function normalizeSkillHeader(value) {
  return String(value ?? "").replace(/\s+/g, "").trim().toLowerCase();
}

/** 采集前使用严格结构校验：字段数量、顺序和规范化名称必须全部一致。 */
function skillHeadersMatch(expected = [], actual = []) {
  return expected.length === actual.length && expected.every((header, index) => (
    normalizeSkillHeader(header) === normalizeSkillHeader(actual[index])
  ));
}

/** 以 75% 可视高度向下推进，并始终限制在当前滚动范围内。 */
function nextVirtualScrollTop({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const current = Math.max(0, Number(scrollTop) || 0);
  const viewport = Math.max(0, Number(clientHeight) || 0);
  const max = Math.max(0, (Number(scrollHeight) || 0) - viewport);
  const distance = Math.max(80, Math.floor(viewport * 0.75));
  return Math.min(max, current + distance);
}

export {
  MAX_SKILL_COLLECTION_PAGES,
  MAX_SKILL_COLLECTION_ROWS,
  classifyScrollCollection,
  isVirtualScrollMetrics,
  nextVirtualScrollTop,
  shouldStopAfterNoProgress,
  skillHeadersMatch
};
