import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SKILL_COLLECTION_PAGES, MAX_SKILL_COLLECTION_ROWS,
  classifyCollectionCompletion, classifyScrollCollection, isVirtualScrollMetrics, nextVirtualScrollTop, shouldStopAfterNoProgress, skillHeadersMatch
} from "../../src/content/skill-collection-model.js";

test("shares the 30-page and 1000-row collection limits across layers", () => {
  assert.equal(MAX_SKILL_COLLECTION_PAGES, 30);
  assert.equal(MAX_SKILL_COLLECTION_ROWS, 1000);
});

test("requires the same field count, order and normalized names before collection", () => {
  assert.equal(skillHeadersMatch(["订单号", "SKU 信息"], ["订单号", "SKU信息"]), true);
  assert.equal(skillHeadersMatch(["订单号", "SKU信息"], ["SKU信息", "订单号"]), false);
  assert.equal(skillHeadersMatch(["订单号", "SKU信息"], ["订单号"]), false);
  assert.equal(skillHeadersMatch(["订单号", "SKU信息"], ["订单号", "商品信息"]), false);
});

test("separates bounded success from cancelled or uncertain collection results", () => {
  assert.deepEqual(classifyCollectionCompletion("last-page"), {
    completeness: "complete", completeForRequest: true
  });
  assert.deepEqual(classifyCollectionCompletion("page-limit"), {
    completeness: "bounded-complete", completeForRequest: true
  });
  assert.deepEqual(classifyCollectionCompletion("row-limit"), {
    completeness: "bounded-complete", completeForRequest: true
  });
  assert.deepEqual(classifyCollectionCompletion("stopped"), {
    completeness: "cancelled", completeForRequest: false
  });
  assert.deepEqual(classifyCollectionCompletion("page-timeout"), {
    completeness: "uncertain", completeForRequest: false
  });
  assert.deepEqual(classifyCollectionCompletion("next-click-failed"), {
    completeness: "incomplete", completeForRequest: false
  });
});

test("recognizes explicit framework virtual-scroll class names", () => {
  const metrics = { scrollHeight: 1000, clientHeight: 300, renderedRowHeights: [40, 40, 40] };
  assert.equal(isVirtualScrollMetrics({ className: "ant-virtual-list-holder", ...metrics }), true);
  assert.equal(isVirtualScrollMetrics({ className: "arco-virtual-scroll", ...metrics }), true);
});

test("ignores virtual-looking containers without a real scroll range or rows", () => {
  assert.equal(isVirtualScrollMetrics({
    className: "ant-virtual-list-holder", scrollHeight: 300, clientHeight: 300, renderedRowHeights: [40]
  }), false);
  assert.equal(isVirtualScrollMetrics({
    className: "virtual-scroll", scrollHeight: 1000, clientHeight: 300, renderedRowHeights: []
  }), false);
});

test("recognizes recycled rows through unrendered scroll-height gap", () => {
  assert.equal(isVirtualScrollMetrics({
    className: "art-table-body",
    scrollHeight: 2400,
    clientHeight: 400,
    renderedRowHeights: [40, 40, 40, 40]
  }), true);
});

test("does not scroll an ordinary table whose rows are already in the DOM", () => {
  assert.equal(isVirtualScrollMetrics({
    className: "ant-table-body",
    scrollHeight: 400,
    clientHeight: 200,
    renderedRowHeights: Array(10).fill(40)
  }), false);
});

test("does not treat a long document as a scrollable data source", () => {
  assert.equal(classifyScrollCollection({
    className: "page-content art-table",
    scrollHeight: 8000,
    clientHeight: 800,
    renderedRowHeights: Array(10).fill(40),
    isDocumentScroller: true
  }), "none");
});

test("separates confirmed virtual lists from one-step probe candidates", () => {
  const metrics = { scrollHeight: 2000, clientHeight: 400, renderedRowHeights: Array(5).fill(40) };
  assert.equal(classifyScrollCollection({ className: "ant-virtual-list-holder", ...metrics }), "confirmed");
  assert.equal(classifyScrollCollection({ className: "custom-scroll-body", ...metrics }), "probe");
  assert.equal(classifyScrollCollection({
    className: "document", ...metrics, isDocumentScroller: true, hasVirtualLayoutEvidence: true
  }), "confirmed");
});

test("advances by 75 percent of the viewport and clamps at the bottom", () => {
  assert.equal(nextVirtualScrollTop({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 }), 300);
  assert.equal(nextVirtualScrollTop({ scrollTop: 1750, scrollHeight: 2000, clientHeight: 400 }), 1600);
});

test("stops after two consecutive scroll steps without new rows", () => {
  assert.equal(shouldStopAfterNoProgress(0), false);
  assert.equal(shouldStopAfterNoProgress(1), false);
  assert.equal(shouldStopAfterNoProgress(2), true);
});
