/**
 * @fileoverview 技能工作台临时文件数据源的装载与规范化。
 *
 * 文件仅转换为当前工作台会话使用的数据源对象；本模块不访问技能存储，
 * 也不修改 STATE。工作表选择交给调用方，便于 Overlay 继续使用现有弹窗。
 */

import { parseSpreadsheetFile } from "./spreadsheet-file.js";

const MAX_SKILL_RUNTIME_FILES = 5;

function chooseSkillRuntimeFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    }, { once: true });
    document.documentElement.appendChild(input);
    input.click();
  });
}

function availableSkillRuntimeFileSlots(dataSources = [], maximum = MAX_SKILL_RUNTIME_FILES) {
  const used = (dataSources || []).filter((item) => item?.runtimeOnly).length;
  return Math.max(0, Math.trunc(Number(maximum) || MAX_SKILL_RUNTIME_FILES) - used);
}

function resolveSkillRuntimeSheet(sheets = [], answer = "") {
  const normalized = String(answer ?? "").trim();
  const index = Number.parseInt(normalized, 10) - 1;
  return Number.isInteger(index) && sheets[index]
    ? sheets[index]
    : sheets.find((sheet) => sheet?.name === normalized) || null;
}

function createSkillRuntimeFileSource(file, sheet) {
  const fileName = String(file?.name || "未命名文件");
  const sheetName = String(sheet?.name || "");
  return {
    runtimeOnly: true,
    sourceType: "file",
    source: { sourceType: "file", fileName, sheetName },
    name: sheetName ? `${fileName} / ${sheetName}` : fileName,
    status: "complete",
    data: sheet?.data,
    error: "",
    collectionId: "",
    collection: null,
    collectionMaxPages: 1,
    previewPage: 1
  };
}

async function loadSkillRuntimeFileSources(files = [], {
  availableSlots = MAX_SKILL_RUNTIME_FILES,
  parseFile = parseSpreadsheetFile,
  chooseSheet = async (_file, sheets) => sheets[0]
} = {}) {
  const items = [];
  const failures = [];
  const limit = Math.max(0, Math.min(MAX_SKILL_RUNTIME_FILES, Math.trunc(Number(availableSlots) || 0)));
  for (const file of Array.from(files || []).slice(0, limit)) {
    try {
      const sheets = await parseFile(file);
      if (!Array.isArray(sheets) || !sheets.length) throw new Error("文件中没有可读取的工作表");
      const selected = sheets.length > 1 ? await chooseSheet(file, sheets) : sheets[0];
      if (!selected) continue;
      items.push(createSkillRuntimeFileSource(file, selected));
    } catch (error) {
      failures.push({ fileName: String(file?.name || "未命名文件"), error: String(error?.message ?? error) });
    }
  }
  return { items, failures };
}

export {
  MAX_SKILL_RUNTIME_FILES,
  availableSkillRuntimeFileSlots,
  chooseSkillRuntimeFiles,
  createSkillRuntimeFileSource,
  loadSkillRuntimeFileSources,
  resolveSkillRuntimeSheet
};
