/**
 * @fileoverview 单次模型请求的推理开关参数适配。
 *
 * `thinking` 与 `enable_thinking` 都不是通用 OpenAI Chat Completions 字段。
 * 只对已知供应商/模型发送对应参数；未知兼容服务保持原请求体，避免因为
 * 额外字段导致整个请求被拒绝。该选择只属于当前调用，不写入模型配置。
 */

function thinkingRequestFields(settings = {}, thinkingEnabled) {
  if (typeof thinkingEnabled !== "boolean") return { fields: {}, mode: "default" };
  const baseUrl = String(settings.baseUrl || "").toLowerCase();
  const model = String(settings.model || "").toLowerCase();
  if (baseUrl.includes("api.deepseek.com")) {
    return {
      fields: { thinking: { type: thinkingEnabled ? "enabled" : "disabled" } },
      mode: "deepseek-thinking"
    };
  }
  if (baseUrl.includes("dashscope") || /(?:qwen|qwq|kimi|glm|deepseek)/.test(model)) {
    return { fields: { enable_thinking: thinkingEnabled }, mode: "enable-thinking" };
  }
  return { fields: {}, mode: "unsupported" };
}

export { thinkingRequestFields };
