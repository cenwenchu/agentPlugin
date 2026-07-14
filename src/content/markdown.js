/**
 * @fileoverview 简易 Markdown → HTML 渲染器。
 * 用正则将 AI 返回的 Markdown 文本转为 HTML，用于 overlay 中的对话气泡。
 *
 * 支持的语法：
 * - 代码块（``` ... ```）和行内代码（`...`）
 * - 表格（GFM 风格）
 * - 标题（#, ##, ###）
 * - 粗体（**）、斜体（*）、粗斜体（***）
 * - 链接（[text](url)）
 * - 无序列表（- 或 *）和有序列表（1. ...）
 * - 段落和换行
 */

/**
 * 将 Markdown 文本转为 HTML 字符串。
 * 做了基础的 XSS 防护（HTML 转义 + URL 协议白名单）。
 * @param {string} text - Markdown 格式文本
 * @returns {string} HTML 字符串
 */
function renderMarkdown(text) {
  if (!text) return "";
  let html = text;

  // 1. 转义 HTML 特殊字符（防止 XSS，但保留后续 markdown 标记）
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. 代码块（``` ... ```）— 必须在其他标记之前处理
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langClass = lang ? ` class="lang-${lang}"` : "";
    return `<pre${langClass}><code>${code.trim()}</code></pre>`;
  });

  // 3. 行内代码 (`...`)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 4. 表格 — 先处理，避免被其他规则干扰
  //    匹配完整的 markdown 表格块
  html = html.replace(/(^\|.+\|\n)(\|[-:| ]+\|\n)((\|.+\|\n?)*)/gm, (match) => {
    const lines = match.trim().split("\n");
    if (lines.length < 2) return match;

    // 解析表头
    const headerCells = parseTableRow(lines[0]);
    // 跳过分隔行（第二行）
    const bodyRows = lines.slice(2).map((l) => parseTableRow(l));

    let tableHtml = "<table><thead><tr>";
    for (const cell of headerCells) tableHtml += `<th>${cell}</th>`;
    tableHtml += "</tr></thead><tbody>";
    for (const row of bodyRows) {
      if (row.length === 0) continue;
      tableHtml += "<tr>";
      for (const cell of row) tableHtml += `<td>${cell}</td>`;
      tableHtml += "</tr>";
    }
    tableHtml += "</tbody></table>";
    return tableHtml;
  });

  // 5. 标题（## 或 ###）
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // 6. 粗体 + 斜体 ***
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  // 7. 粗体 **
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // 8. 斜体 *
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // 9. 链接 [text](url) — 对 URL 做 sanitize，防止 javascript: 协议
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = /^https?:\/\//i.test(url) ? url : "";
    return safeUrl
      ? `<a href="${safeUrl}" target="_blank" rel="noopener">${text}</a>`
      : text;
  });

  // 10. 无序列表 - 或 *
  html = html.replace(/^[\s]*[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // 11. 有序列表 1.
  html = html.replace(/^[\s]*\d+\.\s+(.+)$/gm, "<li>$1</li>");
  // 注意：有序列表和无序列表都用 <li>，需要区分包裹
  // 这里简单处理：如果连续 <li> 被 <ul> 包裹后还有剩余 <li>，再包一层 <ol>
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    if (match.includes("<ul>")) return match;
    return `<ol>${match}</ol>`;
  });

  // 12. 换行 — 双换行为段落
  html = html.replace(/\n\n/g, "</p><p>");
  // 单换行为 <br>
  html = html.replace(/\n/g, "<br>");

  // 包裹段落（如果没有被其他块级标签包裹）
  if (!html.startsWith("<")) {
    html = `<p>${html}</p>`;
  }

  return html;
}

/**
 * 解析 Markdown 表格的一行，返回单元格数组。
 * @param {string} line - 表格行文本
 * @returns {string[]} 单元格内容数组
 */
function parseTableRow(line) {
  // 去掉首尾的 |
  const trimmed = line.replace(/^\s*\||\|\s*$/g, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

export { renderMarkdown, parseTableRow };
