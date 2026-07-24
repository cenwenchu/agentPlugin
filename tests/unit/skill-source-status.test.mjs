import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSkillSourceRecoveryHint,
  buildSkillTestUnavailableMessage,
  collectSkillUnavailableSources,
  isSkillSourceReusableForDraft,
  isSkillSourceUnavailableForTest,
  skillSourceStatusLabel
} from "../../src/content/skill-source-status.js";

const skill = {
  id: "skill_1",
  sources: [
    { id: "source_1", displayName: "订单明细" },
    { id: "source_2", displayName: "售后明细" }
  ]
};

test("labels known source statuses for workspace and overlay copy", () => {
  assert.equal(skillSourceStatusLabel({ status: "checking" }), "校验中");
  assert.equal(skillSourceStatusLabel({ status: "changed" }), "数据源已变化");
  assert.equal(skillSourceStatusLabel({ status: "unknown-status" }), "unknown-status");
});

test("blocks testing for unavailable source statuses", () => {
  assert.equal(isSkillSourceUnavailableForTest({ status: "checking" }), true);
  assert.equal(isSkillSourceUnavailableForTest({ status: "missing" }), true);
  assert.equal(isSkillSourceUnavailableForTest({ status: "ambiguous" }), true);
  assert.equal(isSkillSourceUnavailableForTest({ status: "changed" }), true);
  assert.equal(isSkillSourceUnavailableForTest({ status: "available" }), false);
  assert.equal(isSkillSourceUnavailableForTest({ status: "deferred" }), false);
});

test("only recommends draft reuse for available source statuses", () => {
  assert.equal(isSkillSourceReusableForDraft({ status: "available" }), true);
  assert.equal(isSkillSourceReusableForDraft({ status: "deferred" }), true);
  assert.equal(isSkillSourceReusableForDraft({ status: "checking" }), false);
  assert.equal(isSkillSourceReusableForDraft({ status: "changed" }), false);
  assert.equal(isSkillSourceReusableForDraft({ status: "ambiguous" }), false);
  assert.equal(isSkillSourceReusableForDraft({ status: "missing" }), false);
});

test("collects every source that should prevent immediate testing", () => {
  const unavailable = collectSkillUnavailableSources(skill, {
    source_1: { status: "checking" },
    source_2: { status: "available" }
  });
  assert.deepEqual(unavailable.map((item) => [item.index, item.source.displayName, item.detail.status]), [
    [0, "订单明细", "checking"]
  ]);
});

test("builds a retry message for transient source status problems", () => {
  const message = buildSkillTestUnavailableMessage(skill, {
    source_1: { status: "checking" },
    source_2: { status: "available" }
  });
  assert.match(message, /当前数据源状态不可用/);
  assert.match(message, /校验中/);
  assert.match(message, /订单明细/);
  assert.match(message, /暂时不可测试/);
  assert.match(message, /请稍后再试/);
});

test("builds a rebind hint when the source binding is no longer valid", () => {
  const message = buildSkillTestUnavailableMessage(skill, {
    source_1: { status: "changed" },
    source_2: { status: "missing" }
  });
  assert.match(message, /数据源已变化/);
  assert.match(message, /数据源失效/);
  assert.match(message, /订单明细、售后明细/);
  assert.match(message, /切换到正确的 Tab/);
  assert.match(message, /修改技能/);
  assert.match(message, /重新选择数据源/);
});

test("builds a concise recovery hint for changed sources", () => {
  const hint = buildSkillSourceRecoveryHint(skill, {
    source_1: { status: "changed" },
    source_2: { status: "available" }
  });
  assert.match(hint, /多个业务 Tab 共用同一张表/);
  assert.match(hint, /切换到正确的 Tab/);
  assert.match(hint, /表结构已更新/);
  assert.match(hint, /修改技能/);
});
