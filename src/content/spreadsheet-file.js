/**
 * @fileoverview 浏览器内本地 CSV/XLSX 解析器。
 * 文件内容不会上传或写入 chrome.storage；调用方仅获得规范化表格数据。
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_ROWS = 10000;
const MAX_COLUMNS = 500;
// XLSX 是 ZIP 容器，压缩文件大小不能代表解压后内存占用。两层上限
// 同时防止单个异常 XML 和多 entry 累计形成 ZIP bomb。
const MAX_XLSX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_WORKSHEET_CELLS = 1_000_000;

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseDelimitedText(input, delimiter = "") {
  const source = String(input ?? "").replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const selectedDelimiter = delimiter || [",", "\t", ";"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === selectedDelimiter) { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(cell); cell = "";
      if (row.some((value) => compact(value))) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => compact(value))) rows.push(row);
  return normalizeRows(rows);
}

function normalizeRows(rows) {
  if (!rows.length) return { headers: [], rows: [], rowCount: 0, totalRowCount: 0, truncated: false };
  const width = Math.min(MAX_COLUMNS, Math.max(...rows.map((row) => row.length)));
  if (rows.length * width > MAX_WORKSHEET_CELLS) {
    throw new Error(`单个工作表不能超过 ${MAX_WORKSHEET_CELLS.toLocaleString("en-US")} 个单元格`);
  }
  const rawHeaders = rows[0].slice(0, width);
  const headers = Array.from({ length: width }, (_, index) => compact(rawHeaders[index]) || `列${index + 1}`);
  const allRows = rows.slice(1).filter((row) => row.some((value) => compact(value))).map((row) => (
    Array.from({ length: width }, (_, index) => String(row[index] ?? ""))
  ));
  const limitedRows = allRows.slice(0, MAX_DATA_ROWS);
  return {
    headers,
    rows: limitedRows,
    rowCount: limitedRows.length,
    totalRowCount: allRows.length,
    truncated: allRows.length > limitedRows.length
  };
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  return -1;
}

async function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("不是有效的 XLSX 文件");
  let entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw new Error("XLSX 的 ZIP64 目录不完整");
    const zip64Offset = Number(view.getBigUint64(locator + 8, true));
    if (!Number.isSafeInteger(zip64Offset) || view.getUint32(zip64Offset, true) !== 0x06064b50) throw new Error("XLSX 的 ZIP64 目录无效");
    entryCount = Number(view.getBigUint64(zip64Offset + 32, true));
    offset = Number(view.getBigUint64(zip64Offset + 48, true));
  }
  const decoder = new TextDecoder();
  const entries = new Map();
  let totalUncompressedBytes = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    if (offset < 0 || offset + 46 > bytes.length) throw new Error("XLSX 压缩目录越界");
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX 压缩目录损坏");
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize32 = view.getUint32(offset + 24, true);
    let uncompressedSize = uncompressedSize32;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (flags & 1) throw new Error(`XLSX 条目已加密，无法读取：${name}`);
    if (compressedSize === 0xffffffff || uncompressedSize32 === 0xffffffff || localOffset === 0xffffffff) {
      let extraOffset = offset + 46 + nameLength;
      const extraEnd = extraOffset + extraLength;
      while (extraOffset + 4 <= extraEnd) {
        const fieldId = view.getUint16(extraOffset, true);
        const fieldSize = view.getUint16(extraOffset + 2, true);
        if (fieldId === 0x0001) {
          let cursor = extraOffset + 4;
          if (uncompressedSize32 === 0xffffffff) { uncompressedSize = Number(view.getBigUint64(cursor, true)); cursor += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(view.getBigUint64(cursor, true)); cursor += 8; }
          if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(cursor, true));
          break;
        }
        extraOffset += 4 + fieldSize;
      }
    }
    if (![compressedSize, uncompressedSize, localOffset].every(Number.isSafeInteger)) throw new Error(`XLSX 条目过大，无法读取：${name}`);
    if (uncompressedSize > MAX_XLSX_ENTRY_BYTES) throw new Error(`XLSX 条目解压后过大：${name}`);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) throw new Error("XLSX 解压后总大小超过限制");
    if (localOffset < 0 || localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`XLSX 本地条目损坏：${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset < 0 || dataOffset + compressedSize > bytes.length) throw new Error(`XLSX 条目数据越界：${name}`);
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let data;
    if (compression === 0) data = compressed;
    else if (compression === 8) {
      if (typeof DecompressionStream !== "function") throw new Error("当前浏览器不支持 XLSX 解压");
      try {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        throw new Error(`XLSX 解压失败（${name}）：${String(error?.message ?? error)}`);
      }
    } else throw new Error(`暂不支持 XLSX 压缩方式 ${compression}`);
    if (data.byteLength !== uncompressedSize) throw new Error(`XLSX 条目解压大小不一致：${name}`);
    entries.set(name.replace(/^\//, ""), data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xml(entries, name) {
  const bytes = entries.get(name);
  if (!bytes) return null;
  const document = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error(`XLSX XML 损坏：${name}`);
  return document;
}

function columnIndex(cellReference = "") {
  const letters = String(cellReference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function relationshipTarget(base, target) {
  const parts = `${base}/${target}`.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop(); else normalized.push(part);
  }
  return normalized.join("/");
}

function readSharedStrings(entries) {
  const document = xml(entries, "xl/sharedStrings.xml");
  if (!document) return [];
  return Array.from(document.getElementsByTagName("si")).map((item) => (
    Array.from(item.getElementsByTagName("t")).map((node) => node.textContent || "").join("")
  ));
}

function readWorksheet(document, sharedStrings) {
  const rows = Array.from(document.getElementsByTagName("row")).map((rowNode) => {
    const values = [];
    for (const cell of Array.from(rowNode.getElementsByTagName("c"))) {
      const index = columnIndex(cell.getAttribute("r") || "");
      if (index >= MAX_COLUMNS) continue;
      const type = cell.getAttribute("t") || "";
      const raw = cell.getElementsByTagName("v")[0]?.textContent ?? "";
      const inline = Array.from(cell.getElementsByTagName("t")).map((node) => node.textContent || "").join("");
      values[index] = type === "s" ? (sharedStrings[Number(raw)] ?? "")
        : type === "inlineStr" ? inline
          : type === "b" ? (raw === "1" ? "TRUE" : "FALSE")
            : raw || inline;
    }
    return values;
  }).filter((row) => row.some((value) => compact(value)));
  return normalizeRows(rows);
}

async function parseXlsx(buffer) {
  const entries = await unzipEntries(buffer);
  const workbook = xml(entries, "xl/workbook.xml");
  const relationships = xml(entries, "xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw new Error("XLSX 缺少工作簿信息");
  const targets = new Map(Array.from(relationships.getElementsByTagName("Relationship")).map((node) => [
    node.getAttribute("Id"), node.getAttribute("Target")
  ]));
  const sharedStrings = readSharedStrings(entries);
  const sheets = [];
  for (const sheet of Array.from(workbook.getElementsByTagName("sheet"))) {
    const id = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = targets.get(id);
    if (!target) continue;
    const document = xml(entries, relationshipTarget("xl", target));
    if (!document) continue;
    sheets.push({ name: sheet.getAttribute("name") || `Sheet${sheets.length + 1}`, data: readWorksheet(document, sharedStrings) });
  }
  if (!sheets.length) throw new Error("XLSX 中没有可读取的工作表");
  return sheets;
}

async function parseSpreadsheetFile(file) {
  if (!file) throw new Error("未选择文件");
  if (file.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 10MB");
  const extension = String(file.name || "").split(".").pop()?.toLowerCase();
  if (extension === "csv" || extension === "tsv") {
    const data = parseDelimitedText(await file.text(), extension === "tsv" ? "\t" : "");
    if (!data.headers.length) throw new Error("文件中没有可读取的数据");
    return [{ name: "", data }];
  }
  if (extension === "xlsx") return parseXlsx(await file.arrayBuffer());
  throw new Error("仅支持 CSV、TSV 和 XLSX 文件");
}

export {
  MAX_FILE_BYTES, MAX_DATA_ROWS, MAX_COLUMNS, MAX_WORKSHEET_CELLS,
  MAX_XLSX_ENTRY_BYTES, MAX_XLSX_UNCOMPRESSED_BYTES,
  normalizeRows, parseDelimitedText, parseSpreadsheetFile
};
