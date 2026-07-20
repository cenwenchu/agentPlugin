import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { showPromptDialog, showTextDialog } from "../../src/content/dialog.js";

function dispatchPointer(target, type) {
  target.dispatchEvent(new target.ownerDocument.defaultView.Event(type, { bubbles: true, composed: true }));
}

test("drag-selecting from a prompt input onto the mask does not close the dialog", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  const result = showPromptDialog("修改当前页面名称", "原名称");
  const host = document.querySelector("[data-web2ai-ui='dialog']");
  const input = host.shadowRoot.querySelector("input");
  const mask = host.shadowRoot.querySelector(".mask");

  dispatchPointer(input, "pointerdown");
  dispatchPointer(mask, "pointerup");
  assert.equal(host.isConnected, true);

  host.shadowRoot.querySelector(".confirm").click();
  assert.equal(await result, "原名称");
  dom.window.close();
  delete globalThis.document;
});

test("a complete pointer click on the mask still cancels the dialog", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  const result = showPromptDialog("设置翻页数量", "全部");
  const host = document.querySelector("[data-web2ai-ui='dialog']");
  const mask = host.shadowRoot.querySelector(".mask");

  dispatchPointer(mask, "pointerdown");
  dispatchPointer(mask, "pointerup");
  assert.equal(await result, null);
  assert.equal(host.isConnected, false);
  dom.window.close();
  delete globalThis.document;
});

test("shows a large readonly submitted-content snapshot", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  const result = showTextDialog("提交给大模型的完整内容", "【分析任务】\n检查订单", { confirmText: "复制内容" });
  const host = document.querySelector("[data-web2ai-ui='dialog']");
  assert.equal(host.shadowRoot.querySelector(".title").textContent, "提交给大模型的完整内容");
  assert.equal(host.shadowRoot.querySelector("textarea").readOnly, true);
  assert.match(host.shadowRoot.querySelector("textarea").value, /检查订单/);
  host.shadowRoot.querySelector(".cancel").click();
  assert.equal(await result, false);
  dom.window.close();
  delete globalThis.document;
});
