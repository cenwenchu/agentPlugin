import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelSkillWorkspaceCollectionPageSelection,
  clampSkillWorkspaceActiveSource,
  createSkillWorkspaceSession,
  invalidateSkillWorkspaceResult,
  selectSkillWorkspacePreview,
  skillWorkspaceHasAllSourceData,
  skillWorkspaceMethodDirty,
  skillWorkspaceResultStatusMessage,
  updateSkillWorkspaceCollectionProgress
} from "../../src/content/skill-workspace-state.js";

const skill = {
  id: "skill-1",
  name: "订单分析",
  sources: [
    { id: "source-1", pageKey: "/orders", displayName: "订单明细", businessTabTitle: "订单" },
    { id: "source-2", pageKey: "/refunds", pageTitle: "售后页面" }
  ]
};

test("creates a workspace session without changing the existing STATE.skillTest shape", () => {
  const session = createSkillWorkspaceSession({ skill, method: "分析异常订单", currentPageKey: "/orders" });
  assert.equal(session.skillId, "skill-1");
  assert.equal(session.returnBusinessTabTitle, "订单");
  assert.equal(session.savedMethod, "分析异常订单");
  assert.deepEqual(session.dataSources.map((item) => [item.sourceType, item.name, item.status]), [
    ["web", "订单明细", "ready"],
    ["web", "售后页面", "ready"]
  ]);
});

test("invalidates only derived results when runtime sources change", () => {
  const session = createSkillWorkspaceSession({ skill, method: "分析" });
  session.status = "complete";
  session.response = "旧结果";
  session.submittedPrompt = "旧请求";
  session.methodReview = "旧建议";
  session.attempts = 2;
  session.dataSources[0].data = { rows: [["A"]] };
  invalidateSkillWorkspaceResult(session);
  assert.equal(session.status, "ready");
  assert.equal(session.response, "");
  assert.equal(session.submittedPrompt, "");
  assert.equal(session.attempts, 0);
  assert.deepEqual(session.dataSources[0].data.rows, [["A"]], "loaded source data remains available");
});

test("derives reuse, dirty-method and active-source state", () => {
  const session = createSkillWorkspaceSession({ skill, method: "分析\n结果" });
  assert.equal(skillWorkspaceHasAllSourceData(session), false);
  session.dataSources.forEach((item) => { item.data = { rows: [] }; });
  assert.equal(skillWorkspaceHasAllSourceData(session), true);
  session.dataSources[0].data.completeForRequest = false;
  assert.equal(skillWorkspaceHasAllSourceData(session), false, "incomplete collection must trigger a fresh reload on retry");
  session.method = "分析\u00a0\n结果\n\n\n";
  assert.equal(skillWorkspaceMethodDirty(session), false, "layout whitespace uses the existing normalized comparison");
  session.method = "分析其他结果";
  assert.equal(skillWorkspaceMethodDirty(session), true);
  session.activeDataSourceIndex = 99;
  assert.equal(clampSkillWorkspaceActiveSource(session), 1);
});

test("clamps preview pages and returns only the current rows", () => {
  const item = { previewPage: 9, data: { rows: [[1], [2], [3], [4], [5]] } };
  assert.deepEqual(selectSkillWorkspacePreview(item, 2), {
    rows: item.data.rows,
    page: 3,
    pageCount: 3,
    pageRows: [[5]]
  });
});

test("updates collection progress only for the active workspace route", () => {
  const session = createSkillWorkspaceSession({ skill, method: "分析" });
  session.collectionId = "current";
  session.dataSources[1].collectionId = "source-2-run";
  assert.equal(updateSkillWorkspaceCollectionProgress(session, "unknown", { rowCount: 9 }), false);
  assert.equal(session.collection, null);
  assert.equal(updateSkillWorkspaceCollectionProgress(session, "source-2-run", { rowCount: 3 }), true);
  assert.deepEqual(session.dataSources[1].collection, { rowCount: 3 });
  assert.deepEqual(session.collection, { rowCount: 3 });
});

test("cancelling page-count selection returns the source to retryable state", () => {
  const session = createSkillWorkspaceSession({ skill, method: "分析" });
  const item = session.dataSources[0];
  session.status = "loading";
  session.collectionId = "pending";
  session.collection = { phase: "locating" };
  session.collectionStopRequested = true;
  item.status = "loading";
  item.collectionId = "pending";
  item.collection = { phase: "locating" };

  assert.equal(cancelSkillWorkspaceCollectionPageSelection(session, item), true);
  assert.equal(item.status, "ready");
  assert.equal(item.collectionId, "");
  assert.equal(session.status, "error");
  assert.equal(session.collectionStopRequested, false);
  assert.match(session.error, /已取消数据源载入/);
  assert.match(session.error, /重新开始/);
});

test("derives result-panel copy from collection and model phases", () => {
  const session = createSkillWorkspaceSession({ skill, method: "分析" });
  assert.equal(skillWorkspaceResultStatusMessage(session), "");
  session.pending = true;
  session.status = "loading";
  assert.equal(skillWorkspaceResultStatusMessage(session), "正在采集数据...");
  session.status = "submitting";
  assert.equal(skillWorkspaceResultStatusMessage(session), "已经提交给大模型，正在等待模型返回...");
  session.status = "analyzing";
  assert.equal(skillWorkspaceResultStatusMessage(session), "已经提交给大模型，正在等待模型返回...");
  session.status = "unknown-pending-state";
  assert.equal(skillWorkspaceResultStatusMessage(session), "正在处理...");
});
