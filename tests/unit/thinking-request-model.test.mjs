import test from "node:test";
import assert from "node:assert/strict";
import { thinkingRequestFields } from "../../src/content/thinking-request-model.js";

test("uses DeepSeek thinking object for one-request reasoning control", () => {
  assert.deepEqual(
    thinkingRequestFields({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" }, true),
    { fields: { thinking: { type: "enabled" } }, mode: "deepseek-thinking" }
  );
  assert.deepEqual(
    thinkingRequestFields({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" }, false),
    { fields: { thinking: { type: "disabled" } }, mode: "deepseek-thinking" }
  );
});

test("uses enable_thinking for known hybrid-thinking compatible models", () => {
  assert.deepEqual(
    thinkingRequestFields({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" }, false),
    { fields: { enable_thinking: false }, mode: "enable-thinking" }
  );
  assert.deepEqual(
    thinkingRequestFields({ baseUrl: "https://example.test/v1", model: "glm-5" }, true),
    { fields: { enable_thinking: true }, mode: "enable-thinking" }
  );
});

test("does not inject non-standard thinking fields into unknown providers", () => {
  assert.deepEqual(
    thinkingRequestFields({ baseUrl: "https://example.test/v1", model: "custom-chat" }, true),
    { fields: {}, mode: "unsupported" }
  );
  assert.deepEqual(
    thinkingRequestFields({ baseUrl: "https://example.test/v1", model: "custom-chat" }, undefined),
    { fields: {}, mode: "default" }
  );
});
