import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/orders"
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.location = dom.window.location;
dom.window.Element.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40
});

const {
  getRowCells, hasHeaderCells, isHeaderRow, isTableFooterOrSummaryRow
} = await import("../../src/content/table-row-dom.js");
const { findHeaderRowAbove } = await import("../../src/content/table-header-resolver.js");
const { findPaginationNextButton } = await import("../../src/content/table-pagination-dom.js");
const {
  alignedRowCellTexts, extractHeaders, extractStoredSourceData, tableCandidates
} = await import("../../src/content/skill-source-dom.js");

function installDom(html) {
  document.body.innerHTML = html;
  return () => {
    document.body.innerHTML = "";
  };
}

test("table row DOM helpers preserve HTML and ARIA cell semantics", () => {
  const cleanup = installDom(`
    <table><thead><tr id="head"><th>订单</th><th>状态</th></tr></thead>
      <tbody><tr id="row"><td>A-1</td><td>待处理</td></tr></tbody>
      <tfoot><tr id="summary"><td>合计</td><td>1</td></tr></tfoot></table>
    <div role="row" id="aria"><span role="gridcell">B-2</span><span role="gridcell">完成</span></div>
  `);
  try {
    assert.equal(getRowCells(document.querySelector("#row")).length, 2);
    assert.equal(getRowCells(document.querySelector("#aria")).length, 2);
    assert.equal(isHeaderRow(document.querySelector("#head")), true);
    assert.equal(hasHeaderCells(document.querySelector("#row")), false);
    assert.equal(isTableFooterOrSummaryRow(document.querySelector("#summary")), true);
  } finally {
    cleanup();
  }
});

test("header resolver associates split fixed-header and body tables", () => {
  const cleanup = installDom(`
    <section class="ant-table-wrapper">
      <table class="header"><thead><tr id="fixed-head"><th>商品</th><th>库存</th></tr></thead></table>
      <table class="body"><tbody><tr id="body-row"><td>键盘</td><td>8</td></tr></tbody></table>
    </section>
  `);
  try {
    assert.equal(findHeaderRowAbove(document.querySelector("#body-row"))?.id, "fixed-head");
  } finally {
    cleanup();
  }
});

test("pagination lookup stays scoped to the row container and skips disabled Ant buttons", () => {
  const cleanup = installDom(`
    <section class="ant-drawer-body">
      <table><tbody><tr id="row"><td>1</td></tr></tbody></table>
      <ul class="ant-pagination">
        <li class="ant-pagination-next ant-pagination-disabled"><button id="disabled">下一页</button></li>
        <li class="ant-pagination-next"><button id="next">下一页</button></li>
      </ul>
    </section>
  `);
  try {
    assert.equal(findPaginationNextButton(document.querySelector("#row"))?.id, "next");
  } finally {
    cleanup();
  }
});

test("skill source DOM keeps component identity and empty cell alignment", () => {
  const cleanup = installDom(`
    <section class="ant-table-wrapper" id="orders-wrapper">
      <table id="orders"><thead><tr><th>订单</th><th>备注</th><th>状态</th></tr></thead>
        <tbody><tr><td>A-1</td><td></td><td>待处理</td></tr></tbody></table>
    </section>
  `);
  try {
    assert.deepEqual(tableCandidates().map((node) => node.id), ["orders-wrapper"]);
    assert.deepEqual(extractHeaders(document.querySelector("#orders-wrapper")), ["订单", "备注", "状态"]);
    const cells = Array.from(document.querySelectorAll("#orders tbody td"));
    assert.deepEqual(alignedRowCellTexts(cells, 3), ["A-1", "", "待处理"]);
    const data = extractStoredSourceData({
      selector: "#orders",
      tableIndex: 0,
      headers: ["订单", "备注", "状态"]
    });
    assert.equal(data.found, true);
    assert.deepEqual(data.rows, [["A-1", "", "待处理"]]);
  } finally {
    cleanup();
  }
});
