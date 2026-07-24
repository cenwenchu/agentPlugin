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
  getBusinessCellTexts, getBusinessRowText, getRowCells, hasHeaderCells, isHeaderRow, isTableFooterOrSummaryRow
} = await import("../../src/content/table-row-dom.js");
const { findHeaderRowAbove } = await import("../../src/content/table-header-resolver.js");
const {
  findPaginationNextButton, getTableContentDigest, getTableRowTexts, waitForTableDataReady
} = await import("../../src/content/table-pagination-dom.js");
const {
  alignedRowCellTexts, extractHeaders, extractStoredSourceData, extractStoredSourcePreviewData,
  locateStoredSource, resolveStoredSource, tableCandidates
} = await import("../../src/content/skill-source-dom.js");
const { extractTableRowText } = await import("../../src/content/context.js");

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

test("business row helpers ignore derived columns and injected plugin UI", () => {
  const cleanup = installDom(`
    <table>
      <tbody>
        <tr id="row">
          <td>A-1</td>
          <td data-web2ai-derived-column="skill_1">AI结论</td>
          <td>
            <span>待处理</span>
            <button data-web2ai-ui="1">问一下</button>
          </td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    const row = document.querySelector("#row");
    assert.equal(getRowCells(row).length, 2);
    assert.deepEqual(getBusinessCellTexts(row, { emptyPlaceholder: "-" }), ["A-1", "待处理"]);
    assert.equal(getBusinessRowText(row, { separator: " ||| ", emptyPlaceholder: "-" }), "A-1 ||| 待处理");
    assert.equal(extractTableRowText(row), "A-1 ||| 待处理");
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

test("pagination lookup recognizes VXE pager next button", () => {
  const cleanup = installDom(`
    <section>
      <table><tbody><tr id="row"><td>1</td></tr></tbody></table>
      <div class="vxe-pager">
        <button class="vxe-pager--next-btn is--disabled" id="disabled-next">下一页</button>
        <button class="vxe-pager--next-btn" id="next">下一页</button>
      </div>
    </section>
  `);
  try {
    assert.equal(findPaginationNextButton(document.querySelector("#row"))?.id, "next");
  } finally {
    cleanup();
  }
});

test("fast table readiness waits for content stability instead of a fixed two-second delay", async () => {
  const cleanup = installDom(`
    <table id="orders"><tbody><tr><td>A-1</td><td>载入中</td></tr></tbody></table>
  `);
  try {
    const table = document.querySelector("#orders");
    const startedAt = Date.now();
    setTimeout(() => { table.querySelector("td:last-child").textContent = "已完成"; }, 25);
    const rows = await waitForTableDataReady(table, "", 1000, 0, {
      minWaitMs: 20,
      pollIntervalMs: 20,
      stableSamples: 2,
      compareContent: true
    });
    assert.equal(rows, 1);
    assert.equal(table.querySelector("td:last-child").textContent, "已完成");
    assert.ok(Date.now() - startedAt < 500, "fast content should not inherit the legacy two-second floor");
  } finally {
    cleanup();
  }
});

test("table content digest ignores derived-column updates", async () => {
  const cleanup = installDom(`
    <table id="orders">
      <tbody>
        <tr>
          <td>A-1</td>
          <td data-web2ai-derived-column="skill_1">等待分析</td>
          <td>待处理</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    const table = document.querySelector("#orders");
    const beforeRows = getTableRowTexts(table);
    const beforeDigest = getTableContentDigest(table);
    table.querySelector("[data-web2ai-derived-column]").textContent = "分析中...";
    assert.deepEqual(getTableRowTexts(table), beforeRows);
    assert.equal(getTableContentDigest(table), beforeDigest);
    const rows = await waitForTableDataReady(table, beforeDigest, 300, 0, {
      minWaitMs: 20,
      pollIntervalMs: 20,
      stableSamples: 2,
      compareContent: true
    });
    assert.equal(rows, 1);
  } finally {
    cleanup();
  }
});

test("fast table readiness does not resolve while the table reports loading", async () => {
  const cleanup = installDom(`
    <section id="wrapper" aria-busy="true">
      <table id="orders"><tbody><tr><td>A-1</td></tr></tbody></table>
    </section>
  `);
  try {
    const table = document.querySelector("#orders");
    const wrapper = document.querySelector("#wrapper");
    setTimeout(() => wrapper.removeAttribute("aria-busy"), 70);
    const startedAt = Date.now();
    const rows = await waitForTableDataReady(table, "", 1000, 0, {
      minWaitMs: 20,
      pollIntervalMs: 20,
      stableSamples: 2,
      compareContent: true,
      waitForLoading: true
    });
    assert.equal(rows, 1);
    assert.ok(Date.now() - startedAt >= 70, "loading state must delay readiness");
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

test("skill source DOM switches from split header table to body table when rows live separately", () => {
  const cleanup = installDom(`
    <section class="vxe-table--render-wrapper">
      <div class="vxe-table--header-wrapper">
        <table id="ticket-header" class="vxe-table--header">
          <thead>
            <tr>
              <th>工单号</th>
              <th>创建时间</th>
              <th>公司名</th>
            </tr>
          </thead>
        </table>
      </div>
      <div class="vxe-table--body-wrapper">
        <table id="ticket-body" class="vxe-table--body">
          <tbody>
            <tr>
              <td>3251942</td>
              <td>2026-07-24 13:26:57</td>
              <td>台州市信驰眼镜有限公司</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `);
  try {
    const source = {
      selector: "#ticket-header",
      tableIndex: 0,
      headers: ["工单号", "创建时间", "公司名"]
    };
    const data = extractStoredSourceData(source);
    const preview = extractStoredSourcePreviewData(source);
    assert.equal(data.found, true);
    assert.equal(preview.found, true);
    assert.deepEqual(data.headers, source.headers);
    assert.deepEqual(preview.headers, source.headers);
    assert.equal(data.rowCount, 1);
    assert.deepEqual(data.rows, [[
      "3251942",
      "2026-07-24 13:26:57",
      "台州市信驰眼镜有限公司"
    ]]);
    assert.deepEqual(preview.rows, [[
      "3251942",
      "2026-07-24 13:26:57",
      "台州市信驰眼镜有限公司"
    ]]);
  } finally {
    cleanup();
  }
});

test("skill source DOM ignores derived headers and derived row cells", () => {
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr>
          <th data-web2ai-derived-column="skill_1">AI结论</th>
          <th>订单</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td data-web2ai-derived-column="skill_1">高风险</td>
          <td>A-1</td>
          <td>待处理</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    const table = document.querySelector("#orders");
    assert.deepEqual(extractHeaders(table), ["订单", "状态"]);
    const data = extractStoredSourceData({
      selector: "#orders",
      tableIndex: 0,
      headers: ["订单", "状态"]
    });
    assert.equal(data.found, true);
    assert.deepEqual(data.rows, [["A-1", "待处理"]]);
  } finally {
    cleanup();
  }
});

test("skill source preview keeps current-page duplicate rows for derived preview", () => {
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr>
          <th>订单号</th>
          <th>订单金额</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>A-1</td><td>100</td></tr>
        <tr><td>A-2</td><td>100</td></tr>
      </tbody>
    </table>
  `);
  try {
    const data = extractStoredSourcePreviewData({
      selector: "#orders",
      tableIndex: 0,
      headers: ["订单号", "订单金额"]
    });
    assert.equal(data.found, true);
    assert.deepEqual(data.rows, [
      ["A-1", "100"],
      ["A-2", "100"]
    ]);
  } finally {
    cleanup();
  }
});

test("skill source data ignores fixed summary rows at the bottom", () => {
  const cleanup = installDom(`
    <div class="ant-table-wrapper" id="orders-wrapper">
      <table id="orders">
        <thead>
          <tr><th>订单号</th><th>订单金额</th></tr>
        </thead>
        <tbody>
          <tr><td>A-1</td><td>100</td></tr>
          <tr><td>A-2</td><td>200</td></tr>
        </tbody>
      </table>
      <div class="ant-table-summary">
        <table>
          <tbody>
            <tr><td>合计</td><td>300</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `);
  try {
    const source = {
      selector: "#orders",
      tableIndex: 0,
      headers: ["订单号", "订单金额"]
    };
    const stored = extractStoredSourceData(source);
    const preview = extractStoredSourcePreviewData(source);
    assert.equal(stored.found, true);
    assert.equal(preview.found, true);
    assert.deepEqual(stored.rows, [
      ["A-1", "100"],
      ["A-2", "200"]
    ]);
    assert.deepEqual(preview.rows, [
      ["A-1", "100"],
      ["A-2", "200"]
    ]);
    assert.equal(stored.totalRowCount, 2);
    assert.equal(preview.totalRowCount, 2);
  } finally {
    cleanup();
  }
});

test("scored locator prefers exact headers over a drifting positional selector on multi-table pages", () => {
  const cleanup = installDom(`
    <div class="art-table" id="wrong-table">
      <table>
        <thead><tr><th>序号</th><th>店铺链接</th><th>成交转化 更多指标</th></tr></thead>
        <tbody><tr><td>1</td><td>链接A</td><td>12</td></tr></tbody>
      </table>
    </div>
    <div class="art-table" id="plan-table">
      <table>
        <thead><tr><th>序号</th><th>计划预算及消耗</th><th>计划转化 更多指标</th></tr></thead>
        <tbody><tr><td>1</td><td>100</td><td>9</td></tr></tbody>
      </table>
    </div>
  `);
  try {
    const source = {
      selector: "#wrong-table",
      selectorStrength: "positional",
      tableIndex: 0,
      headers: ["序号", "计划预算及消耗", "计划转化 更多指标"],
      componentType: "art-table",
      locatorVersion: 2
    };
    const located = locateStoredSource(source, {
      skillType: "derived-column",
      selectedColumns: [
        { header: "计划预算及消耗", occurrence: 1 },
        { header: "计划转化 更多指标", occurrence: 1 }
      ]
    });
    assert.equal(located.status, "available");
    assert.equal(located.table?.id, "plan-table");
    assert.equal(located.matchMethod, "scored-candidate");
  } finally {
    cleanup();
  }
});

test("scored locator keeps only the active tab table when tab panes coexist in the DOM", () => {
  const cleanup = installDom(`
    <div class="tabs">
      <button class="plan-realTab" aria-selected="true">计划</button>
      <button class="link-realTab" aria-selected="false">链接</button>
    </div>
    <section id="plan-pane">
      <div class="art-table" id="plan-table">
        <table>
          <thead><tr><th>序号</th><th>计划预算及消耗</th><th>计划转化 更多指标</th></tr></thead>
          <tbody><tr><td>1</td><td>100</td><td>9</td></tr></tbody>
        </table>
      </div>
    </section>
    <section id="link-pane" style="display:none">
      <div class="art-table" id="link-table">
        <table>
          <thead><tr><th>序号</th><th>店铺链接</th><th>成交转化 更多指标</th></tr></thead>
          <tbody><tr><td>1</td><td>链接A</td><td>12</td></tr></tbody>
        </table>
      </div>
    </section>
  `);
  try {
    const resolved = resolveStoredSource({
      selector: "#link-table",
      selectorStrength: "positional",
      tableIndex: 0,
      headers: ["序号", "计划预算及消耗", "计划转化 更多指标"],
      componentType: "art-table",
      locatorVersion: 2
    }, {
      skillType: "derived-column",
      selectedColumns: [
        { header: "计划预算及消耗", occurrence: 1 },
        { header: "计划转化 更多指标", occurrence: 1 }
      ]
    });
    assert.equal(resolved.found, true);
    assert.equal(resolved.status, "available");
    assert.equal(resolved.selectedColumnCoverage, 1);
  } finally {
    cleanup();
  }
});

test("scored locator returns ambiguous when multiple visible tables are equally valid", () => {
  const cleanup = installDom(`
    <div class="art-table" id="orders-a">
      <table>
        <thead><tr><th>订单号</th><th>状态</th></tr></thead>
        <tbody><tr><td>A-1</td><td>待处理</td></tr></tbody>
      </table>
    </div>
    <div class="art-table" id="orders-b">
      <table>
        <thead><tr><th>订单号</th><th>状态</th></tr></thead>
        <tbody><tr><td>B-1</td><td>完成</td></tr></tbody>
      </table>
    </div>
  `);
  try {
    const located = locateStoredSource({
      selector: "#missing-table",
      selectorStrength: "positional",
      headers: ["订单号", "状态"],
      componentType: "art-table",
      locatorVersion: 2
    });
    assert.equal(located.table, null);
    assert.equal(located.status, "ambiguous");
    assert.equal(located.ambiguous, true);
  } finally {
    cleanup();
  }
});
