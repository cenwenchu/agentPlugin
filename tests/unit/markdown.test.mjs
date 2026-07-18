import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { convertSafeHtmlToMarkdown } from "../../src/content/html-to-markdown.js";
import { renderMarkdown } from "../../src/content/markdown.js";

const { DOMParser } = new JSDOM("").window;

test("converts common model HTML into Markdown before rendering", () => {
  const markdown = convertSafeHtmlToMarkdown("<p><strong>利润：</strong>278.8万<br><em>净收入</em>：645.1万</p>", DOMParser);
  assert.equal(markdown, "**利润：**278.8万\n*净收入*：645.1万");
});

test("converts safe links, lists and tables", () => {
  const markdown = convertSafeHtmlToMarkdown(
    '<a href="https://example.com">详情</a><ul><li>风险一</li><li>风险二</li></ul><table><tr><th>渠道</th><th>利润</th></tr><tr><td>A</td><td>10</td></tr></table>',
    DOMParser
  );
  assert.match(markdown, /\[详情\]\(https:\/\/example\.com\)/);
  assert.match(markdown, /- 风险一\n- 风险二/);
  assert.match(markdown, /\| 渠道 \| 利润 \|/);
});

test("drops dangerous nodes and unsafe link protocols", () => {
  const markdown = convertSafeHtmlToMarkdown('<script>alert(1)</script><a href="javascript:alert(2)">安全文字</a>', DOMParser);
  assert.equal(markdown, "安全文字");
  assert.doesNotMatch(renderMarkdown(markdown), /script|javascript|alert/);
});

test("does not interpret HTML-looking text inside Markdown code", () => {
  const markdown = convertSafeHtmlToMarkdown("代码：`<br>`，正文：<br>下一行", DOMParser);
  assert.equal(markdown, "代码：`<br>`，正文：\n下一行");
  assert.match(renderMarkdown(markdown), /<code>&lt;br&gt;<\/code>/);
});
