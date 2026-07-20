import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillDataSourcesText, buildSkillRequestPrompt, incompleteSkillDataSources } from "../../src/content/skill-request-model.js";

const source = (name, pageTitle, rows) => ({
  name,
  source: { pageTitle },
  data: {
    headers: ["订单号", "解决方案", "金额"],
    rows,
    rowCount: rows.length,
    totalRowCount: rows.length
  }
});

test("builds the same request shape for one or many data sources", () => {
  const first = source("订单明细", "订单页面", [["A-1", "", "100"]]);
  const second = source("售后明细", "售后页面", [["R-1", "退款", "20"]]);
  const prompt = buildSkillRequestPrompt({ method: "按渠道列表对比", dataSources: [first, second] });
  assert.match(prompt, /【分析任务】\n按渠道列表对比/);
  assert.match(prompt, /### 数据源 1：订单明细[\s\S]*来源页面：订单页面/);
  assert.match(prompt, /### 数据源 2：售后明细[\s\S]*来源页面：售后页面/);
  assert.match(prompt, /\| A-1 \|  \| 100 \|/, "empty cells must keep their original column");
});

test("shares the request budget so every data source remains present", () => {
  const rows = Array.from({ length: 80 }, (_, index) => [`ORDER-${index}`, "x".repeat(120), index]);
  const text = buildSkillDataSourcesText([
    source("表一", "页面一", rows),
    source("表二", "页面二", rows),
    source("表三", "页面三", rows)
  ], 12000);
  assert.match(text, /### 数据源 1：表一/);
  assert.match(text, /### 数据源 2：表二/);
  assert.match(text, /### 数据源 3：表三/);
  assert.match(text, /已按本次请求上限截取/);
});

test("reports every source that has not completed loading", () => {
  const complete = source("已完成", "页面", [["A", "", "1"]]);
  const missing = { name: "未完成", source: { pageTitle: "页面二" }, data: null };
  assert.deepEqual(incompleteSkillDataSources([complete, missing]), [missing]);
});
