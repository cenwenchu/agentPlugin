import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillDataSourcesText, buildSkillRequestPrompt, calculateSkillRequestBudget, incompleteSkillDataSources } from "../../src/content/skill-request-model.js";

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
  const partial = source("翻页超时", "页面三", [["B", "", "2"]]);
  partial.data.completeForRequest = false;
  partial.data.collectionReason = "page-timeout";
  assert.deepEqual(incompleteSkillDataSources([complete, missing, partial]), [missing, partial]);
});

test("labels uploaded spreadsheets as runtime file sources", () => {
  const fileSource = {
    runtimeOnly: true,
    sourceType: "file",
    name: "售后.xlsx / 明细",
    source: { sourceType: "file", fileName: "售后.xlsx", sheetName: "明细" },
    data: { headers: ["售后单号"], rows: [["R-1"]], rowCount: 1, totalRowCount: 1 }
  };
  const prompt = buildSkillRequestPrompt({ method: "汇总", dataSources: [fileSource] });
  assert.match(prompt, /数据源类型：本次运行上传的临时文件/);
  assert.match(prompt, /文件：售后.xlsx；工作表：明细/);
});

test("derives a larger skill input budget from a larger model context window", () => {
  const small = calculateSkillRequestBudget({ contextWindow: 8192, maxOutputTokens: 4096, method: "分析" });
  const large = calculateSkillRequestBudget({ contextWindow: 1_000_000, maxOutputTokens: 4096, method: "分析" });
  assert.ok(small.maxChars >= 2000);
  assert.ok(large.maxChars > small.maxChars * 100);
  assert.ok(large.maxChars < large.availableTokens, "reserve ten percent for conservative token estimation");
});

test("does not force a large fixed section budget for small-context models", () => {
  const rows = Array.from({ length: 100 }, (_, index) => [`${index}`, "x".repeat(500)]);
  const prompt = buildSkillRequestPrompt({
    method: "分析",
    dataSources: [source("表一", "页面一", rows), source("表二", "页面二", rows)]
  }, 4000);
  assert.match(prompt, /数据源 1：表一/);
  assert.match(prompt, /数据源 2：表二/);
  assert.ok(prompt.length < 6000);
});
