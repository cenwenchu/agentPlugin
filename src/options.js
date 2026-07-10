import { DEFAULT_SETTINGS } from "./shared.js";

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
}

function setStatus(text) {
  $("status").textContent = text;
}

async function load() {
  const data = await chrome.storage.sync.get(["settings"]);
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
  $("baseUrl").value = settings.baseUrl ?? "";
  $("model").value = settings.model ?? "";
  $("apiKey").value = settings.apiKey ?? "";
}

async function save() {
  const baseUrl = $("baseUrl").value.trim();
  const model = $("model").value.trim();
  const apiKey = $("apiKey").value.trim();
  await chrome.storage.sync.set({
    settings: {
      baseUrl: baseUrl || DEFAULT_SETTINGS.baseUrl,
      model: model || DEFAULT_SETTINGS.model,
      apiKey
    }
  });
}

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
