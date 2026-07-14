/**
 * @fileoverview 扩展设置页逻辑。
 * 支持 DeepSeek/OpenAI 兼容/自定义 Chat Completions 服务，
 * 并配置模型上下文窗口、输出预留和本地 API Key。
 */

import { DEFAULT_SETTINGS } from "./shared.js";

const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com" },
  openai: { baseUrl: "https://api.openai.com" }
};

function detectProvider(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return Object.entries(PROVIDERS).find(([, provider]) => provider.baseUrl === normalized)?.[0] || "custom";
}

/**
 * 通过 ID 获取 DOM 元素，若不存在则抛出异常。
 * @param {string} id
 * @returns {HTMLElement}
 */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

/**
 * 设置状态信息的文本内容。
 * @param {string} text
 */
function setStatus(text) {
  $("status").textContent = text;
}

/**
 * 普通设置从 sync 加载；API Key 从 local 加载。
 */
async function load() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(["settings"]),
    chrome.storage.local.get(["apiKey"])
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(syncData.settings ?? {}) };
  $("baseUrl").value = settings.baseUrl ?? "";
  $("provider").value = detectProvider(settings.baseUrl);
  $("model").value = settings.model ?? "";
  $("contextWindow").value = settings.contextWindow ?? DEFAULT_SETTINGS.contextWindow;
  $("maxOutputTokens").value = settings.maxOutputTokens ?? DEFAULT_SETTINGS.maxOutputTokens;
  $("apiKey").value = localData.apiKey ?? settings.apiKey ?? "";
}

/**
 * 普通设置保存到 sync；API Key 单独保存到 local，避免账号同步。
 */
async function save() {
  const baseUrl = $("baseUrl").value.trim();
  const model = $("model").value.trim();
  const apiKey = $("apiKey").value.trim();
  const contextWindow = Math.max(8192, Number($("contextWindow").value) || DEFAULT_SETTINGS.contextWindow);
  const maxOutputTokens = Math.min(
    Math.floor(contextWindow / 2),
    Math.max(256, Number($("maxOutputTokens").value) || DEFAULT_SETTINGS.maxOutputTokens)
  );
  await chrome.storage.sync.set({
    settings: {
      baseUrl: baseUrl || DEFAULT_SETTINGS.baseUrl,
      model: model || DEFAULT_SETTINGS.model,
      contextWindow,
      maxOutputTokens
    }
  });
  await chrome.storage.local.set({ apiKey });
}

/**
 * 通过 background 发送一条简单的 AI 请求来测试连接。
 * @returns {Promise<string>} 返回 AI 的响应文本
 */
async function testConnection() {
  const prompt = "Reply with 'ok'.";
  const resp = await chrome.runtime.sendMessage({
    type: "AI_CHAT",
    payload: {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt }
      ]
    }
  });
  if (!resp?.ok) throw new Error(resp?.error || "Unknown error");
  const text = String(resp.data?.content ?? "").trim();
  if (!text) throw new Error("Empty response");
  return text;
}

// ========== 页面初始化 ==========

document.addEventListener("DOMContentLoaded", async () => {
  await load();

  $("provider").addEventListener("change", () => {
    const provider = PROVIDERS[$("provider").value];
    if (provider) $("baseUrl").value = provider.baseUrl;
  });
  $("baseUrl").addEventListener("input", () => {
    $("provider").value = detectProvider($("baseUrl").value);
  });

  $("save").addEventListener("click", async () => {
    try {
      setStatus("保存中...");
      await save();
      setStatus("已保存");
    } catch (e) {
      setStatus(String(e?.message ?? e));
    }
  });

  $("test").addEventListener("click", async () => {
    try {
      setStatus("测试中...");
      await save();
      const text = await testConnection();
      setStatus(`测试成功：${text.slice(0, 80)}`);
    } catch (e) {
      setStatus(`测试失败：${String(e?.message ?? e)}`);
    }
  });
});
