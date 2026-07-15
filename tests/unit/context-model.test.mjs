import test from "node:test";
import assert from "node:assert/strict";
import { buildContextBlockFromContexts, getTableContextIdentity, groupTableContexts } from "../../src/content/context-model.js";
import { createSseDataParser } from "../../src/sse.js";
import { calculateContextBudget, estimateMessagesTokens, estimateTokens, selectContextsWithinTokenBudget } from "../../src/content/token-budget.js";
import { tableGroupToCsv, tableGroupToMarkdown } from "../../src/content/table-export.js";
import { createContextRef, isContextRef } from "../../src/content/context-ref.js";
import { buildOnboardingPrompt, parseOnboardingResponse } from "../../src/content/onboarding.js";
import { getBusinessRowKey, getRenderedRowIdentity, getRowContentFingerprint, resolveTableAdapter } from "../../src/content/table-adapters.js";

test("groups same-width tables by stable tableId", () => {
  const contexts = [
    { ref: "R2", kind: "table-row", text: "B1 ||| B2", tableId: "table-b" },
    { ref: "H2", kind: "table-header", text: "X ||| Y", tableId: "table-b" },
    { ref: "R1", kind: "table-row", text: "A1 ||| A2", tableId: "table-a" },
    { ref: "H1", kind: "table-header", text: "C1 ||| C2", tableId: "table-a" }
  ];
  const groups = groupTableContexts(contexts);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.tableId === "table-a").header.ref, "H1");
  assert.deepEqual(groups.find((g) => g.tableId === "table-b").rows.map((r) => r.ref), ["R2"]);
});

test("groups split fixed-header and body tables through headerRef", () => {
  const contexts = [
    { ref: "R1", kind: "table-row", text: "A ||| B", tableId: "body-table", headerRef: "H1" },
    { ref: "H1", kind: "table-header", text: "C1 ||| C2", tableId: "fixed-header-table" }
  ];
  const groups = groupTableContexts(contexts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].header.ref, "H1");
  assert.deepEqual(groups[0].rows.map((row) => row.ref), ["R1"]);
});

test("numbers tables chronologically and keeps the newest headerless table on top", () => {
  const contexts = [
    { ref: "R3", kind: "table-row", text: "newest", tableId: "table-c", createdAt: 300 },
    { ref: "H2", kind: "table-header", text: "B", tableId: "table-b", createdAt: 200 },
    { ref: "R2", kind: "table-row", text: "middle", tableId: "table-b", createdAt: 201 },
    { ref: "H1", kind: "table-header", text: "A", tableId: "table-a", createdAt: 100 },
    { ref: "R1", kind: "table-row", text: "oldest", tableId: "table-a", createdAt: 101 }
  ];
  const groups = groupTableContexts(contexts);
  assert.deepEqual(groups.map((group) => group.tableId), ["table-c", "table-b", "table-a"]);
  assert.deepEqual(groups.map((group) => group.tableNumber), [3, 2, 1]);
  assert.equal(groups[0].header, null);
});

test("builds an idempotent identity for single then batch selection", () => {
  const first = { kind: "table-row", rowKey: "table-a::order-1", text: "A", anchorSelector: "tr:nth-of-type(1)" };
  const repeated = { ...first, ref: "another-ref" };
  assert.equal(getTableContextIdentity(first), getTableContextIdentity(repeated));
  assert.notEqual(
    getTableContextIdentity(first),
    getTableContextIdentity({ ...first, rowKey: "table-a::order-2" })
  );
});

test("context builder only includes supplied contexts", () => {
  const selected = [{ ref: "R1", kind: "table-row", text: "selected", tableId: "table-a", title: "T", url: "U" }];
  const block = buildContextBlockFromContexts(selected);
  assert.match(block, /selected/);
  assert.doesNotMatch(block, /unselected/);
});

test("SSE parser handles arbitrary chunks and final event without newline", () => {
  const events = [];
  const parser = createSseDataParser((data) => events.push(data));
  parser.feed("data: {\"choices\":[{\"del");
  parser.feed("ta\":{\"content\":\"A\"}}]}\n\ndata: [DO");
  parser.feed("NE]");
  parser.end();
  assert.deepEqual(events, ['{"choices":[{"delta":{"content":"A"}}]}', "[DONE]"]);
});

test("token budget accounts for history and output reserve", () => {
  const budget = calculateContextBudget({
    contextWindow: 10000,
    maxOutputTokens: 2000,
    reserveTokens: 500,
    messages: [{ role: "user", content: "a".repeat(4000) }]
  });
  assert.equal(budget.historyTokens, 1006);
  assert.equal(budget.availableTokens, 6494);
  assert.equal(estimateTokens("你好abcd"), 3);
});

test("token budget reads text from multimodal user messages", () => {
  const text = "请分析这张截图中的异常订单";
  const tokens = estimateMessagesTokens([{
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } }
    ]
  }]);
  assert.equal(tokens, 2 + 4 + estimateTokens(text));
});

test("structured token trimming keeps headers before recent rows", () => {
  const contexts = [
    { ref: "R1", kind: "table-row", text: "r".repeat(80) },
    { ref: "H1", kind: "table-header", text: "header" }
  ];
  const selected = selectContextsWithinTokenBudget(contexts, 50).contexts;
  assert.deepEqual(selected.map((context) => context.ref), ["H1"]);
});

test("exports table groups as Markdown and escaped CSV", () => {
  const group = {
    header: { text: "名称 ||| 备注" },
    rows: [{ text: 'A ||| 包含,逗号和"引号"' }]
  };
  assert.match(tableGroupToMarkdown(group), /\| 名称 \| 备注 \|/);
  assert.match(tableGroupToCsv(group), /A,"包含,逗号和""引号"""/);
});

test("adds generated headers when exporting a headerless table", () => {
  const csv = tableGroupToCsv({ header: null, rows: [{ text: "A ||| B" }] });
  assert.equal(csv, "列1,列2\r\nA,B");
});

test("accepts both legacy and cross-frame-safe context refs", () => {
  assert.equal(isContextRef("CTX12"), true);
  assert.equal(isContextRef(createContextRef()), true);
  assert.equal(isContextRef("CTX_bad"), false);
});

test("builds data-aware onboarding prompt without full rows", () => {
  const prompt = buildOnboardingPrompt([{
    header: { text: "客户 ||| 金额" },
    rows: [{ text: "A ||| 100" }, { text: "B ||| 200" }, { text: "C ||| 300" }]
  }]);
  assert.match(prompt, /已选数据行数：3/);
  assert.match(prompt, /客户 \|\|\| 金额/);
  assert.doesNotMatch(prompt, /C \|\|\| 300/);
});

test("parses fenced onboarding JSON and validates suggestions", () => {
  const parsed = parseOnboardingResponse('```json\n{"welcome":"你好","summary":"订单数据","suggestions":[{"label":"看概览","prompt":"请概括这些数据","reason":"理解整体"}],"freeInputHint":"也可自由提问"}\n```');
  assert.equal(parsed.suggestions[0].prompt, "请概括这些数据");
  assert.equal(parsed.welcome, "你好");
});

test("resolves component scope and stable business row key", () => {
  const scope = { id: "wrapper" };
  const row = {
    closest: (selector) => selector === ".ant-table-wrapper" ? scope : null,
    getAttribute: (name) => name === "data-row-key" ? "order-42" : null,
    querySelector: () => null
  };
  assert.equal(resolveTableAdapter(row).scope, scope);
  assert.equal(getBusinessRowKey(row), "ant:data-row-key:order-42");
});

test("uses the ArtTable component root instead of an art-table row as scope", () => {
  const componentRoot = { className: "art-table" };
  const row = {
    closest: (selector) => selector === ".art-table" ? componentRoot : null,
    getAttribute: () => null,
    querySelector: () => null
  };
  const resolved = resolveTableAdapter(row);
  assert.equal(resolved.adapter.name, "art");
  assert.equal(resolved.scope, componentRoot);
});

test("distinguishes recycled virtual rows by business key or leading-column fingerprint", () => {
  assert.notEqual(
    getRenderedRowIdentity("orders", "row:1", "same text"),
    getRenderedRowIdentity("orders", "row:2", "same text")
  );
  assert.equal(
    getRowContentFingerprint("- ||| A   Corp ||| 100 ||| ignored"),
    getRowContentFingerprint("A Corp ||| 100 ||| ignored")
  );
  assert.notEqual(
    getRenderedRowIdentity("orders", "", "A ||| 100"),
    getRenderedRowIdentity("orders", "", "B ||| 100")
  );
  assert.equal(
    getRowContentFingerprint("1 ||| ORDER-1 ||| 待处理", 2),
    getRowContentFingerprint("1 ||| ORDER-1 ||| 已刷新", 2)
  );
});
