/**
 * frameHasMatchingSkill（skills.js 内部辅助）的单测。
 *
 * 该函数决定"当前 frame 是否可能渲染任一技能的横条"，用于让无匹配技能的 frame
 * 跳过 renderSkillBars 全文档扫描与 3s 定时重建（性能优化，不影响渲染语义——
 * 与 renderSkillBars 内部的 frameMatches 过滤保持一致）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// 在导入被测模块前装好全局 DOM/location，供 pageKey(location.href) 使用。
function installLocation(url) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  return () => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.HTMLElement;
    delete globalThis.Element;
    delete globalThis.Node;
  };
}

const CURRENT = "https://innerorder.scm121.com/afterSales";
installLocation(CURRENT);
const { __test } = await import("../../src/content/skills.js");
const { frameHasMatchingSkill } = __test;

function skillWithFrameUrl(frameUrl) {
  return { id: "s1", pageSources: [{ id: "src1", frameUrl }] };
}

test("frameHasMatchingSkill: 无技能时返回 false", () => {
  assert.equal(frameHasMatchingSkill([]), false);
  assert.equal(frameHasMatchingSkill(), false);
});

test("frameHasMatchingSkill: source.frameUrl 与当前 frame 同源同路径时返回 true", () => {
  const skills = [skillWithFrameUrl("https://innerorder.scm121.com/afterSales?tab=1")];
  assert.equal(frameHasMatchingSkill(skills), true);
});

test("frameHasMatchingSkill: source.frameUrl 不同路径时返回 false（本 frame 应跳过渲染）", () => {
  const skills = [skillWithFrameUrl("https://src-sc.scm121.com/erp-data/adConsole/home")];
  assert.equal(frameHasMatchingSkill(skills), false);
});

test("frameHasMatchingSkill: source.frameUrl 为空视为可跨 frame 展示，返回 true", () => {
  const skills = [skillWithFrameUrl("")];
  assert.equal(frameHasMatchingSkill(skills), true);
});

test("frameHasMatchingSkill: 多个 source 任一匹配即返回 true", () => {
  const skills = [
    { id: "s1", pageSources: [{ id: "a", frameUrl: "https://src-sc.scm121.com/erp-data/adConsole/home" }] },
    { id: "s2", pageSources: [{ id: "b", frameUrl: "https://innerorder.scm121.com/afterSales" }] }
  ];
  assert.equal(frameHasMatchingSkill(skills), true);
});
