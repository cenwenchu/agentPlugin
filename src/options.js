/** 模型配置页：同步模型元数据，本地保存每个模型独立的 API Key。 */
import { DEFAULT_MODEL_PROFILE } from "./shared.js";

let profiles = [];
let activeId = "";
let defaultId = "";
let apiKeys = {};
let creating = false;
let createDraft = null;
let createApiKey = "";

function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}

function setStatus(text) { $("status").textContent = text; }
function makeId() { return globalThis.crypto?.randomUUID?.() || `model_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function normalizeProfile(profile = {}) {
  const contextWindow = Math.max(8192, Number(profile.contextWindow) || DEFAULT_MODEL_PROFILE.contextWindow);
  const model = String(profile.model || DEFAULT_MODEL_PROFILE.model);
  return {
    ...DEFAULT_MODEL_PROFILE,
    ...profile,
    id: String(profile.id || makeId()),
    model,
    name: model,
    supportsImages: profile.supportsImages === true,
    contextWindow,
    maxOutputTokens: Math.min(
      Math.floor(contextWindow / 2),
      Math.max(256, Number(profile.maxOutputTokens) || DEFAULT_MODEL_PROFILE.maxOutputTokens)
    )
  };
}

function currentProfile() { return creating ? createDraft : profiles.find((profile) => profile.id === activeId); }

function createBlankProfile() {
  return {
    ...DEFAULT_MODEL_PROFILE,
    id: makeId(),
    name: "未命名模型",
    baseUrl: "",
    model: "",
    supportsImages: false
  };
}

function readForm() {
  const profile = currentProfile();
  if (!profile) return;
  profile.baseUrl = $("baseUrl").value.trim();
  profile.model = $("model").value.trim();
  profile.name = profile.model || "未命名模型";
  profile.supportsImages = $("supportsImages").checked;
  if (creating) createApiKey = $("apiKey").value.trim();
  else apiKeys[profile.id] = $("apiKey").value.trim();
}

function writeForm() {
  const profile = currentProfile();
  if (!profile) return;
  $("baseUrl").value = profile.baseUrl;
  $("model").value = profile.model;
  $("apiKey").value = creating ? createApiKey : (apiKeys[profile.id] || "");
  $("supportsImages").checked = profile.supportsImages === true;
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
  $("createTitle").hidden = !creating;
  document.querySelector(".profile-select").hidden = creating;
  $("setDefault").hidden = creating;
  $("addProfile").hidden = creating;
  $("deleteProfile").hidden = creating;
  $("cancelAdd").hidden = !creating;
  $("save").textContent = creating ? "保存新模型" : "保存修改";
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
  const editing = currentProfile();
  if (!editing || !String(editing.baseUrl || "").trim() || !String(editing.model || "").trim()) {
    throw new Error("请填写接口 URL 和模型参数");
  }
  if (creating) {
    profiles.push(editing);
    apiKeys[editing.id] = createApiKey;
    activeId = editing.id;
    if (!defaultId) defaultId = editing.id;
    creating = false;
    createDraft = null;
    createApiKey = "";
  }
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
    creating = true;
    createDraft = profiles.length ? createBlankProfile() : normalizeProfile({ id: makeId() });
    createApiKey = "";
    renderProfileSelect();
    writeForm();
    setStatus("请填写新模型配置");
  });
  $("cancelAdd").addEventListener("click", () => {
    creating = false;
    createDraft = null;
    createApiKey = "";
    renderProfileSelect();
    writeForm();
    setStatus("已取消新增");
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
  $("save").addEventListener("click", async () => {
    try { setStatus("保存中..."); await save(); setStatus("已保存"); }
    catch (error) { setStatus(String(error?.message ?? error)); }
  });
  $("test").addEventListener("click", async () => {
    try { setStatus("测试中..."); const text = await testConnection(); setStatus(`测试成功：${text.slice(0, 80)}`); }
    catch (error) { setStatus(`测试失败：${String(error?.message ?? error)}`); }
  });
});
