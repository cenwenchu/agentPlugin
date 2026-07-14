/**
 * @fileoverview 扩展设置页逻辑。
 * 支持配置 DeepSeek API 的 Base URL、Model 和 API Key，
 * 并提供"测试连接"功能验证配置是否正确。
 */

import { DEFAULT_SETTINGS } from "./shared.js";

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
 * 从 chrome.storage.sync 加载已保存的设置并填充表单。
 */
async function load() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(["settings"]),
    chrome.storage.local.get(["apiKey"])
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(syncData.settings ?? {}) };
  $("baseUrl").value = settings.baseUrl ?? "";
  $("model").value = settings.model ?? "";
  $("contextWindow").value = settings.contextWindow ?? DEFAULT_SETTINGS.contextWindow;
  $("maxOutputTokens").value = settings.maxOutputTokens ?? DEFAULT_SETTINGS.maxOutputTokens;
  $("apiKey").value = localData.apiKey ?? settings.apiKey ?? "";
}

/**
 * 将表单中的设置保存到 chrome.storage.sync。
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
