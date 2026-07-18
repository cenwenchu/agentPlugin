/**
 * @fileoverview 将模型偶尔返回的安全 HTML 子集转换为 Markdown。
 *
 * 不允许任何原始 HTML 穿透到渲染层：危险节点被删除，未知标签只保留文本，
 * 链接仅允许 HTTP(S)。转换后的内容仍会经过 markdown.js 的统一 HTML 转义。
 */

const KNOWN_HTML_TAG = /<(?:br|p|div|strong|b|em|i|h[1-6]|ul|ol|li|a|code|pre|blockquote|del|s|strike|hr|table|thead|tbody|tr|th|td|img|script|style|iframe|object|embed)\b/i;

function protectMarkdownCode(text) {
  const values = [];
  const protectedText = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (match) => {
    const token = `\uE000WEB2AI_CODE_${values.length}\uE001`;
    values.push(match);
    return token;
  });
  return {
    text: protectedText,
    restore: (value) => value.replace(/\uE000WEB2AI_CODE_(\d+)\uE001/g, (_, index) => values[Number(index)] || "")
  };
}

function htmlTableToMarkdown(table) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll("th,td")).map((cell) => cell.textContent.trim().replace(/\|/g, "\\|"))
  ).filter((row) => row.length);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  return [
    `| ${normalized[0].join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function htmlNodeToMarkdown(node) {
  if (node.nodeType === 3) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toLowerCase();
  if (["script", "style", "iframe", "object", "embed"].includes(tag)) return "";
  const children = () => Array.from(node.childNodes).map(htmlNodeToMarkdown).join("");
  if (tag === "br") return "\n";
  if (["p", "div"].includes(tag)) return `\n\n${children()}\n\n`;
  if (["strong", "b"].includes(tag)) return `**${children()}**`;
  if (["em", "i"].includes(tag)) return `*${children()}*`;
  if (["del", "s", "strike"].includes(tag)) return `~~${children()}~~`;
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Math.min(3, Number(tag[1])))} ${children().trim()}\n\n`;
  if (tag === "hr") return "\n\n---\n\n";
  if (tag === "blockquote") return `\n\n${children().trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  if (tag === "pre") return `\n\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
  if (tag === "code") return `\`${node.textContent}\``;
  if (tag === "a") {
    const label = children().trim() || node.getAttribute("href") || "";
    const href = node.getAttribute("href") || "";
    return /^https?:\/\//i.test(href) ? `[${label}](${href})` : label;
  }
  if (tag === "img") return node.getAttribute("alt") || "";
  if (tag === "table") return `\n\n${htmlTableToMarkdown(node)}\n\n`;
  if (tag === "ul" || tag === "ol") {
    const items = Array.from(node.children).filter((child) => child.tagName?.toLowerCase() === "li");
    return `\n${items.map((item, index) => `${tag === "ol" ? `${index + 1}.` : "-"} ${Array.from(item.childNodes).map(htmlNodeToMarkdown).join("").trim()}`).join("\n")}\n`;
  }
  if (tag === "li") return children();
  return children();
}

function convertSafeHtmlToMarkdown(input, DOMParserImpl = globalThis.DOMParser) {
  const source = String(input || "");
  if (!source || !KNOWN_HTML_TAG.test(source) || typeof DOMParserImpl !== "function") return source;
  const protectedCode = protectMarkdownCode(source);
  const document = new DOMParserImpl().parseFromString(protectedCode.text, "text/html");
  const markdown = Array.from(document.body.childNodes).map(htmlNodeToMarkdown).join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return protectedCode.restore(markdown);
}

export { convertSafeHtmlToMarkdown };
