/**
 * @fileoverview 共享常量 — 扩展默认设置。
 * 被 background.js（Service Worker）和 options.js（设置页）共同引用。
 */

/**
 * 默认的 OpenAI Chat Completions 兼容接口参数和客户端 token 预算。
 * API Key 单独保存在 chrome.storage.local，不进入同步设置。
 */
export const DEFAULT_SETTINGS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  contextWindow: 64000,
  maxOutputTokens: 4096
};
