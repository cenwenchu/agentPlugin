import test from "node:test";
import assert from "node:assert/strict";
import { applySkillMutation } from "../../src/content/skill-storage-model.js";

const storedSkill = () => ({
  id: "skill-1",
  revision: 2,
  name: "订单分析",
  createdAt: 10,
  updatedAt: 20,
  analysisMethod: { description: "旧方法" },
  sources: [{ id: "source-1", headers: ["订单号"] }]
});

test("updates one skill against the latest collection and increments its revision", () => {
  const current = storedSkill();
  const next = applySkillMutation({ skills: [current, { id: "skill-2", revision: 4 }] }, {
    type: "UPDATE_ANALYSIS_METHOD",
    skillId: current.id,
    expectedRevision: 2,
    analysisMethod: { description: "新方法" },
    now: 100
  });
  assert.equal(next.skills[0].revision, 3);
  assert.equal(next.skills[0].analysisMethod.description, "新方法");
  assert.equal(next.skills[1].revision, 4, "unrelated concurrent skills must be preserved");
});

test("rejects a stale editor instead of overwriting a newer skill", () => {
  assert.throws(() => applySkillMutation({ skills: [storedSkill()] }, {
    type: "UPSERT_SKILL",
    skill: { ...storedSkill(), name: "陈旧修改" },
    expectedRevision: 1
  }), (error) => error.code === "SKILL_CONFLICT");
});

test("learns a missing business tab but never overwrites a confirmed value", () => {
  const learned = applySkillMutation({ skills: [storedSkill()] }, {
    type: "LEARN_SOURCE_BUSINESS_TAB", skillId: "skill-1", sourceId: "source-1", title: "订单"
  });
  assert.equal(learned.skills[0].sources[0].businessTabTitle, "订单");
  assert.equal(learned.skills[0].revision, 2, "automatic compatibility learning is not a user edit");
  const preserved = applySkillMutation({ skills: learned.skills }, {
    type: "LEARN_SOURCE_BUSINESS_TAB", skillId: "skill-1", sourceId: "source-1", title: "售后"
  });
  assert.equal(preserved.skills[0].sources[0].businessTabTitle, "订单");
  assert.equal(preserved.skills[0].revision, learned.skills[0].revision);
});

test("preserves an automatically learned tab when an already-open draft is saved", () => {
  const learned = applySkillMutation({ skills: [storedSkill()] }, {
    type: "LEARN_SOURCE_BUSINESS_TAB", skillId: "skill-1", sourceId: "source-1", title: "订单"
  });
  const staleDraft = storedSkill();
  staleDraft.name = "订单分析（修改）";
  const saved = applySkillMutation({ skills: learned.skills }, {
    type: "UPSERT_SKILL", skill: staleDraft, expectedRevision: 2, now: 100
  });
  assert.equal(saved.result.name, "订单分析（修改）");
  assert.equal(saved.result.sources[0].businessTabTitle, "订单");
  assert.equal(saved.result.revision, 3);
});

test("merges imports with the latest skills and page names", () => {
  const imported = { ...storedSkill(), id: "skill-3", name: "售后分析", sources: [{ id: "source-3", pageKey: "/refund", headers: ["售后单"] }] };
  const next = applySkillMutation({ skills: [storedSkill()], pageNames: { "/orders": "订单" } }, {
    type: "IMPORT_SKILLS", skills: [imported], pageNames: { "/refund": "售后" }, now: 100
  });
  assert.equal(next.result.added, 1);
  assert.equal(next.skills.length, 2);
  assert.deepEqual(next.pageNames, { "/orders": "订单", "/refund": "售后" });
});

test("skips duplicate imports but still merges latest page-name snapshots", () => {
  const current = storedSkill();
  const duplicate = {
    ...current,
    id: "skill-duplicate",
    sources: [{ id: "source-dup", headers: ["订单号"] }]
  };
  const next = applySkillMutation({ skills: [current], pageNames: { "/orders": "订单" } }, {
    type: "IMPORT_SKILLS",
    skills: [duplicate],
    pageNames: { "/refund": "售后" },
    now: 100
  });
  assert.equal(next.result.added, 0);
  assert.equal(next.skills.length, 1);
  assert.deepEqual(next.pageNames, { "/orders": "订单", "/refund": "售后" });
});

test("deletes one skill without touching unrelated skills", () => {
  const current = storedSkill();
  const preserved = { id: "skill-2", revision: 4, name: "售后分析", sources: [{ id: "source-2", headers: ["售后单"] }] };
  const next = applySkillMutation({ skills: [current, preserved], pageNames: { "/orders": "订单" } }, {
    type: "DELETE_SKILL",
    skillId: current.id,
    expectedRevision: 2
  });
  assert.deepEqual(next.result, { deletedId: current.id });
  assert.deepEqual(next.skills.map((skill) => skill.id), ["skill-2"]);
  assert.deepEqual(next.pageNames, { "/orders": "订单" });
});

test("deletes all skills together with page names", () => {
  const next = applySkillMutation({
    skills: [storedSkill(), { id: "skill-2", revision: 1, name: "售后分析", sources: [{ id: "source-2", headers: ["售后单"] }] }],
    pageNames: { "/orders": "订单", "/refund": "售后" }
  }, {
    type: "DELETE_ALL_SKILLS"
  });
  assert.deepEqual(next.result, { deletedAll: true });
  assert.deepEqual(next.skills, []);
  assert.deepEqual(next.pageNames, {});
});
