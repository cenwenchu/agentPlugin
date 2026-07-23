/**
 * @fileoverview 共享常量 — 扩展默认设置。
 * 被 background.js（Service Worker）和 options.js（设置页）共同引用。
 */

/**
 * 默认的 OpenAI Chat Completions 兼容接口参数和客户端 token 预算。
 * API Key 单独保存在 chrome.storage.local，不进入同步设置。
 */
export const DEFAULT_MODEL_PROFILE = {
  id: "default",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  supportsImages: false,
  contextWindow: 64000,
  maxOutputTokens: 4096,
  pageRequestLimitPerMinute: 5
};

export const DEFAULT_SETTINGS = {
  models: [DEFAULT_MODEL_PROFILE],
  activeModelId: DEFAULT_MODEL_PROFILE.id,
  defaultModelId: DEFAULT_MODEL_PROFILE.id
};

/**
 * 创建设置页的新增模型草稿。已有模型时返回空白草稿；首次配置时预填
 * DeepSeek，避免把“新增第二个模型”和“首次引导”混为一体。
 */
export function createNewModelProfile({ hasProfiles, id }) {
  return {
    ...DEFAULT_MODEL_PROFILE,
    id,
    name: hasProfiles ? "未命名模型" : DEFAULT_MODEL_PROFILE.model,
    baseUrl: hasProfiles ? "" : DEFAULT_MODEL_PROFILE.baseUrl,
    model: hasProfiles ? "" : DEFAULT_MODEL_PROFILE.model,
    supportsImages: false
  };
}

export function validateModelProfile(profile) {
  if (!String(profile?.baseUrl || "").trim()) return { ok: false, field: "baseUrl" };
  if (!String(profile?.model || "").trim()) return { ok: false, field: "model" };
  return { ok: true };
}
