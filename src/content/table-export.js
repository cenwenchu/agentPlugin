/** 表格上下文的纯导出层；不访问 DOM，便于测试和未来增加 XLSX。 */
function splitCells(text, separator = " ||| ") {
  return String(text ?? "").split(separator).map((cell) => cell.trim());
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function tableGroupToMarkdown(group, separator = " ||| ") {
  const rows = group.rows.map((row) => splitCells(row.text, separator));
  const width = Math.max(group.header ? splitCells(group.header.text, separator).length : 0, ...rows.map((row) => row.length), 1);
  const header = group.header ? splitCells(group.header.text, separator) : Array.from({ length: width }, (_, i) => `列${i + 1}`);
  const normalize = (row) => Array.from({ length: width }, (_, i) => escapeMarkdownCell(row[i] ?? ""));
  return [normalize(header), Array(width).fill("---"), ...rows.map(normalize)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableGroupToCsv(group, separator = " ||| ") {
  const rows = [];
  if (group.header) rows.push(splitCells(group.header.text, separator));
  else {
    const width = Math.max(...group.rows.map((row) => splitCells(row.text, separator).length), 1);
    rows.push(Array.from({ length: width }, (_, i) => `列${i + 1}`));
  }
  rows.push(...group.rows.map((row) => splitCells(row.text, separator)));
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

export { tableGroupToMarkdown, tableGroupToCsv };
