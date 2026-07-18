/** 模型配置页：同步模型元数据，本地保存每个模型独立的 API Key。 */
import { DEFAULT_MODEL_PROFILE } from "./shared.js";

const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com" },
  openai: { baseUrl: "https://api.openai.com" }
};

let profiles = [];
let activeId = "";
let defaultId = "";
let apiKeys = {};

function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}

function setStatus(text) { $("status").textContent = text; }
function makeId() { return globalThis.crypto?.randomUUID?.() || `model_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function detectProvider(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return Object.entries(PROVIDERS).find(([, provider]) => provider.baseUrl === normalized)?.[0] || "custom";
}

function normalizeProfile(profile = {}) {
  const contextWindow = Math.max(8192, Number(profile.contextWindow) || DEFAULT_MODEL_PROFILE.contextWindow);
  return {
    ...DEFAULT_MODEL_PROFILE,
    ...profile,
    id: String(profile.id || makeId()),
    name: String(profile.name || profile.model || "未命名模型"),
    supportsImages: profile.supportsImages === true,
    contextWindow,
    maxOutputTokens: Math.min(
      Math.floor(contextWindow / 2),
      Math.max(256, Number(profile.maxOutputTokens) || DEFAULT_MODEL_PROFILE.maxOutputTokens)
    )
  };
}

function currentProfile() { return profiles.find((profile) => profile.id === activeId); }

function readForm() {
  const profile = currentProfile();
  if (!profile) return;
  profile.name = $("name").value.trim() || $("model").value.trim() || "未命名模型";
  profile.baseUrl = $("baseUrl").value.trim() || DEFAULT_MODEL_PROFILE.baseUrl;
  profile.model = $("model").value.trim() || DEFAULT_MODEL_PROFILE.model;
  profile.supportsImages = $("supportsImages").checked;
  profile.contextWindow = Math.max(8192, Number($("contextWindow").value) || DEFAULT_MODEL_PROFILE.contextWindow);
  profile.maxOutputTokens = Math.min(
    Math.floor(profile.contextWindow / 2),
    Math.max(256, Number($("maxOutputTokens").value) || DEFAULT_MODEL_PROFILE.maxOutputTokens)
  );
  apiKeys[profile.id] = $("apiKey").value.trim();
}

function writeForm() {
  const profile = currentProfile();
  if (!profile) return;
  $("name").value = profile.name;
  $("baseUrl").value = profile.baseUrl;
  $("provider").value = detectProvider(profile.baseUrl);
  $("model").value = profile.model;
  $("apiKey").value = apiKeys[profile.id] || "";
  $("supportsImages").checked = profile.supportsImages === true;
  $("contextWindow").value = profile.contextWindow;
  $("maxOutputTokens").value = profile.maxOutputTokens;
}

function renderProfileSelect() {
  $("profile").replaceChildren(...profiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name}${profile.id === defaultId ? "（默认）" : ""}`;
    option.selected = profile.id === activeId;
    return option;
  }));
  $("deleteProfile").disabled = profiles.length <= 1;
  const isDefault = activeId === defaultId;
  $("setDefault").textContent = isDefault ? "当前默认" : "设为默认";
  $("setDefault").classList.toggle("is-default", isDefault);
  $("setDefault").disabled = isDefault;
}

async function load() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(["settings"]),
    chrome.storage.local.get(["apiKey", "modelApiKeys"])
  ]);
  const settings = syncData.settings ?? {};
  if (Array.isArray(settings.models) && settings.models.length) {
    profiles = settings.models.map(normalizeProfile);
    defaultId = profiles.some((profile) => profile.id === settings.defaultModelId)
      ? settings.defaultModelId
      : profiles.some((profile) => profile.id === settings.activeModelId) ? settings.activeModelId : profiles[0].id;
    activeId = defaultId;
    apiKeys = { ...(localData.modelApiKeys ?? {}) };
  } else {
    const legacy = normalizeProfile({ ...settings, id: "default", name: settings.model || DEFAULT_MODEL_PROFILE.name });
    profiles = [legacy];
    activeId = legacy.id;
    defaultId = legacy.id;
    apiKeys = { [legacy.id]: localData.apiKey || settings.apiKey || "" };
  }
  renderProfileSelect();
  writeForm();
}

async function save() {
  readForm();
  await Promise.all([
    chrome.storage.sync.set({ settings: { models: profiles, activeModelId: defaultId, defaultModelId: defaultId } }),
    chrome.storage.local.set({ modelApiKeys: apiKeys })
  ]);
  renderProfileSelect();
}

async function testConnection() {
  await save();
  const response = await chrome.runtime.sendMessage({
    type: "AI_CHAT",
    payload: { modelId: activeId, messages: [{ role: "user", content: "Reply with 'ok'." }] }
  });
  if (!response?.ok) throw new Error(response?.error || "Unknown error");
  return String(response.data?.content ?? "").trim();
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  $("profile").addEventListener("change", (event) => {
    readForm();
    activeId = event.target.value;
    writeForm();
    renderProfileSelect();
  });
  $("setDefault").addEventListener("click", () => {
    readForm();
    defaultId = activeId;
    renderProfileSelect();
    setStatus("已设为默认模型，请点击保存");
  });
  $("addProfile").addEventListener("click", () => {
    readForm();
    const profile = normalizeProfile({ id: makeId(), name: `新模型 ${profiles.length + 1}` });
    profiles.push(profile);
    activeId = profile.id;
    renderProfileSelect();
    writeForm();
  });
  $("deleteProfile").addEventListener("click", () => {
    if (profiles.length <= 1) return;
    const index = profiles.findIndex((profile) => profile.id === activeId);
    delete apiKeys[activeId];
    const deletedDefault = activeId === defaultId;
    profiles.splice(index, 1);
    activeId = profiles[Math.max(0, index - 1)].id;
    if (deletedDefault) defaultId = activeId;
    renderProfileSelect();
    writeForm();
  });
  $("provider").addEventListener("change", () => {
    const provider = PROVIDERS[$("provider").value];
    if (provider) $("baseUrl").value = provider.baseUrl;
  });
  $("baseUrl").addEventListener("input", () => { $("provider").value = detectProvider($("baseUrl").value); });
  $("save").addEventListener("click", async () => {
    try { setStatus("保存中..."); await save(); setStatus("已保存"); }
    catch (error) { setStatus(String(error?.message ?? error)); }
  });
  $("test").addEventListener("click", async () => {
    try { setStatus("测试中..."); const text = await testConnection(); setStatus(`测试成功：${text.slice(0, 80)}`); }
    catch (error) { setStatus(`测试失败：${String(error?.message ?? error)}`); }
  });
});
