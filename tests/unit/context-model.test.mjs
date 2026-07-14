import test from "node:test";
import assert from "node:assert/strict";
import { buildContextBlockFromContexts, groupTableContexts } from "../../src/content/context-model.js";
import { createSseDataParser } from "../../src/sse.js";
import { calculateContextBudget, estimateTokens, selectContextsWithinTokenBudget } from "../../src/content/token-budget.js";

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

test("structured token trimming keeps headers before recent rows", () => {
  const contexts = [
    { ref: "R1", kind: "table-row", text: "r".repeat(80) },
    { ref: "H1", kind: "table-header", text: "header" }
  ];
  const selected = selectContextsWithinTokenBudget(contexts, 50).contexts;
  assert.deepEqual(selected.map((context) => context.ref), ["H1"]);
});
