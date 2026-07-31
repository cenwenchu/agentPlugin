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
globalThis.location = dom.window.location;
globalThis.MutationObserver = dom.window.MutationObserver;

dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 320,
    bottom: 40,
    width: 320,
    height: 40
  };
};

Object.defineProperty(dom.window.Element.prototype, "offsetParent", {
  configurable: true,
  get() {
    return document.body;
  }
});

globalThis.chrome = {
  runtime: {
    connect() {
      return {
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage() {},
        disconnect() {}
      };
    },
    sendMessage() {
      return Promise.resolve({ ok: true });
    }
  },
  storage: {
    session: {
      get() {
        return Promise.resolve({});
      },
      set() {
        return Promise.resolve();
      },
      remove() {
        return Promise.resolve();
      }
    }
  }
};

const {
  clearDerivedRuntimeSkill,
  formatRuntimeNoteText,
  renderDerivedRuntimeNote,
  renderDerivedRuntimeNotes
} = await import("../../src/content/derived-column-renderer.js");
const {
  buildDerivedColumnAnalysisFingerprint,
  buildDerivedColumnRowFingerprint
} = await import("../../src/content/derived-column-fingerprint.js");
const {
  buildDerivedColumnCacheKey,
  parseDerivedColumnCacheKey,
  readDerivedColumnCacheEntries,
  writeDerivedColumnCacheEntries
} = await import("../../src/content/derived-column-cache.js");
const { __test: runtimeTest } = await import("../../src/content/derived-column-controller.js");

function installDom(html) {
  document.body.innerHTML = html;
  return () => {
    document.body.innerHTML = "";
  };
}

test("runtime renderer inserts body cell before selected business column", () => {
  const cleanup = installDom(`
    <table>
      <thead>
        <tr><th></th><th>订单号</th><th>状态</th></tr>
      </thead>
      <tbody>
        <tr id="row">
          <td><input type="checkbox"></td>
          <td id="anchor">A-1</td>
          <td>待处理</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    const row = document.querySelector("#row");
    assert.equal(renderDerivedRuntimeNote({
      skillId: "skill_1",
      rowEl: row,
      status: "complete",
      conclusion: "金额高，建议优先处理",
      insertIndex: 1,
      headerCount: 2
    }), true);
    const bodyRow = document.querySelector("#row");
    const insertedCell = bodyRow.children[2];
    const note = insertedCell.querySelector("[data-web2ai-derived-runtime-note]");
    assert.ok(note);
    assert.equal(note.textContent, "金额高，建议优先处理");
    assert.equal(bodyRow.children[1].id, "anchor");
    assert.equal(clearDerivedRuntimeSkill("skill_1"), 1);
    assert.equal(bodyRow.querySelector("[data-web2ai-derived-runtime-note]"), null);
    assert.equal(document.querySelector("#anchor").textContent.trim(), "A-1");
  } finally {
    cleanup();
  }
});

test("runtime renderer marks the whole derived cell only when attention is required", () => {
  const cleanup = installDom(`
    <table>
      <tbody>
        <tr id="attention"><td>A-1</td></tr>
        <tr id="normal"><td>A-2</td></tr>
      </tbody>
    </table>
  `);
  try {
    renderDerivedRuntimeNote({
      skillId: "skill_attention",
      rowEl: document.querySelector("#attention"),
      status: "complete",
      conclusion: "需要处理",
      needsAttention: true
    });
    renderDerivedRuntimeNote({
      skillId: "skill_attention",
      rowEl: document.querySelector("#normal"),
      status: "complete",
      conclusion: "正常",
      needsAttention: false
    });

    const attentionCell = document.querySelector("#attention [data-web2ai-derived-column]");
    const normalCell = document.querySelector("#normal [data-web2ai-derived-column]");
    assert.equal(attentionCell?.dataset.attention, "true");
    assert.equal(normalCell?.dataset.attention, "false");
    assert.equal(attentionCell?.querySelector("[data-web2ai-derived-runtime-note]")?.dataset.attention, "true");
    assert.equal(normalCell?.querySelector("[data-web2ai-derived-runtime-note]")?.dataset.attention, "false");
  } finally {
    cleanup();
  }
});

test("runtime renderer inserts native column before selected business column", () => {
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr id="header-row">
          <th></th>
          <th>订单号</th>
          <th id="amount-header">金额</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr id="row">
          <td><input type="checkbox"></td>
          <td>A-1</td>
          <td id="amount-cell">100</td>
          <td>待处理</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    const row = document.querySelector("#row");
    const rendered = renderDerivedRuntimeNotes("skill_insert", [{
      rowEl: row,
      status: "complete",
      conclusion: "优先处理",
      error: ""
    }], {
      root: document.querySelector("#orders"),
      headerCount: 3,
      insertIndex: 1,
      outputColumnName: "AI结论"
    });
    assert.equal(rendered, 1);
    const headerRow = document.querySelector("#header-row");
    const bodyRow = document.querySelector("#row");
    const headerCells = Array.from(headerRow.children).map((cell) => cell.textContent.trim());
    const bodyCells = Array.from(bodyRow.children).map((cell) => cell.textContent.trim());
    assert.deepEqual(headerCells, ["", "订单号", "AI结论", "金额", "状态"]);
    assert.equal(bodyCells[2], "优先处理");
    assert.equal(bodyRow.children[3].id, "amount-cell");
  } finally {
    cleanup();
  }
});

test("runtime renderer inserts jtv1 column before selected business column (not into trailing hidden cells)", () => {
  // jtv1（聚水潭 epaas）：表头/表体分离，行内含序号列、复选框列与大量 display:none 隐藏列。
  // 业务可见列：采购单号(389502)、供应商(DKW0001E1)、状态(已确认)。
  // 选中"供应商"（业务列 index 1）插入，应落在其前，而非尾部隐藏列区。
  const cleanup = installDom(`
    <div id="_jt">
      <div id="_jt_row_head"><div id="_jt_row_head_list">
        <div class="_jt_cell_head _jt_cell_head_index">#</div>
        <div class="_jt_cell_head _jt_cbx"><input type="checkbox"></div>
        <div class="_jt_cell_head"><span>采购单号</span></div>
        <div class="_jt_cell_head" style="display:none;"><span>隐藏A</span></div>
        <div class="_jt_cell_head"><span>供应商</span></div>
        <div class="_jt_cell_head"><span>状态</span></div>
        <div class="_jt_cell_head" style="display:none;"><span>隐藏B</span></div>
        <div class="_jt_cell_head" style="display:none;"><span>隐藏C</span></div>
      </div></div>
      <div id="_jt_body"><div id="_jt_body_list">
        <div class="_jt_row _jt_rh" index="0" id="row">
          <div class="_jt_cell _jt_cell_index">1</div>
          <div class="_jt_cell"><input type="checkbox"></div>
          <div class="_jt_cell" id="po-cell">389502</div>
          <div class="_jt_cell" style="display:none;"></div>
          <div class="_jt_cell" id="supplier-cell">DKW0001E1</div>
          <div class="_jt_cell">已确认</div>
          <div class="_jt_cell" style="display:none;"></div>
          <div class="_jt_cell" style="display:none;"></div>
        </div>
      </div></div>
    </div>
  `);
  try {
    const root = document.querySelector("#_jt");
    const row = document.querySelector("#row");
    const rendered = renderDerivedRuntimeNotes("skill_jtv1", [{
      rowEl: row,
      status: "complete",
      conclusion: "优先",
      error: ""
    }], {
      root,
      headerCount: 3,
      insertIndex: 1,
      outputColumnName: "AI结论"
    });
    assert.equal(rendered, 1);
    // 表头：插入的"AI结论"应在"供应商"前
    const headRow = document.querySelector("#_jt_row_head");
    const insertedHeader = headRow.querySelector("[data-web2ai-derived-column-header]");
    assert.ok(insertedHeader, "jtv1 表头应插入派生列表头");
    assert.equal(insertedHeader.textContent.trim(), "AI结论");
    // 表头"供应商"是插入节点的下一个可见兄弟
    const headCells = Array.from(headRow.querySelectorAll("._jt_cell_head"));
    const headerIdx = headCells.indexOf(insertedHeader);
    assert.equal(headCells[headerIdx + 1].textContent.trim(), "供应商");
    // 数据行：插入的单元格应在供应商单元格前（可见业务序列 index 1 处），不在尾部隐藏区
    const bodyCells = Array.from(row.children);
    const insertedBody = row.querySelector("[data-web2ai-derived-column]:not([data-web2ai-derived-column-header])");
    assert.ok(insertedBody, "jtv1 数据行应插入派生列单元格");
    const supplierCell = document.querySelector("#supplier-cell");
    assert.equal(bodyCells.indexOf(insertedBody), bodyCells.indexOf(supplierCell) - 1, "派生列应紧邻供应商列前");
  } finally {
    cleanup();
  }
});

test("runtime renderer cleanup removes generated header, colgroup and body cells", () => {
  const cleanup = installDom(`
    <table id="orders">
      <colgroup>
        <col style="width: 40px">
        <col style="width: 160px">
        <col style="width: 120px">
      </colgroup>
      <thead>
        <tr id="header-row">
          <th></th>
          <th>订单号</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr id="row-1">
          <td><input type="checkbox"></td>
          <td>A-1</td>
          <td>待处理</td>
        </tr>
        <tr id="row-2">
          <td><input type="checkbox"></td>
          <td>A-2</td>
          <td>已完成</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    const rendered = renderDerivedRuntimeNotes("skill_cleanup", [
      { rowEl: document.querySelector("#row-1"), status: "complete", conclusion: "优先处理", error: "" },
      { rowEl: document.querySelector("#row-2"), status: "complete", conclusion: "正常", error: "" }
    ], {
      root: document.querySelector("#orders"),
      headerCount: 2,
      insertIndex: 1,
      outputColumnName: "AI结论"
    });
    assert.equal(rendered, 2);
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column-header]").length, 1);
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column-col]").length, 1);
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column]").length, 3);
    assert.equal(clearDerivedRuntimeSkill("skill_cleanup"), 4);
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column]").length, 0);
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column-col]").length, 0);
  } finally {
    cleanup();
  }
});

test("runtime renderer status text is readable", () => {
  assert.equal(formatRuntimeNoteText({ status: "loading" }), "分析中...");
  assert.equal(formatRuntimeNoteText({ status: "pending" }), "等待分析");
  assert.equal(
    formatRuntimeNoteText({ status: "blocked" }),
    "当前页面已触发访问保护；列表变化后会重新判断，但模型请求仍受当前页面总额度限制。"
  );
  assert.equal(formatRuntimeNoteText({ status: "error", error: "模型请求失败" }), "分析失败：模型请求失败");
});

test("manual runtime is preserved when auto run is disabled", () => {
  const { shouldKeepManualRuntimeWhenAutoDisabled } = runtimeTest;
  assert.equal(shouldKeepManualRuntimeWhenAutoDisabled({
    status: "idle",
    runOptions: { manual: true },
    root: null
  }), false);
  assert.equal(shouldKeepManualRuntimeWhenAutoDisabled({
    status: "running",
    runOptions: null,
    root: null
  }), true);
  assert.equal(shouldKeepManualRuntimeWhenAutoDisabled({
    status: "idle",
    runOptions: null,
    root: null
  }), false);
});

test("cooldown blocked runtime is recognized as blocked", () => {
  const { isRuntimeBlockedByCooldown } = runtimeTest;
  const now = 1_000;
  assert.equal(isRuntimeBlockedByCooldown({ blockedUntil: now + 1 }, now), true);
  assert.equal(isRuntimeBlockedByCooldown({ blockedUntil: now }, now), false);
  assert.equal(isRuntimeBlockedByCooldown({ blockedUntil: 0 }, now), false);
});

test("blocked runtime retries when list signature changes", () => {
  const { shouldRetryBlockedRuntimeForListChange } = runtimeTest;
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr><th>订单号</th><th>状态</th><th data-web2ai-derived-column-header="skill_blocked" data-web2ai-derived-column="skill_blocked">AI结论</th></tr>
      </thead>
      <tbody>
        <tr><td>A-2</td><td>待处理</td><td data-web2ai-derived-column="skill_blocked">当前页面已触发访问保护；列表变化后会重新判断，但模型请求仍受当前页面总额度限制。</td></tr>
      </tbody>
    </table>
  `);
  try {
    const skill = {
      id: "skill_blocked",
      type: "derived-column",
      selectedColumns: [
        { header: "订单号", normalizedHeader: "订单号", occurrence: 1 },
        { header: "状态", normalizedHeader: "状态", occurrence: 1 }
      ]
    };
    assert.equal(shouldRetryBlockedRuntimeForListChange({
      skillId: "skill_blocked",
      root: document.querySelector("#orders"),
      blockedUntil: Date.now() + 60_000,
      blockedListSignature: "old_signature"
    }, skill), true);
  } finally {
    cleanup();
  }
});

test("source-changed blocked runtime stays blocked when current headers are unchanged", () => {
  const { shouldRetryBlockedRuntimeForListChange, buildSourceChangeRetrySignature } = runtimeTest;
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr><th>店铺链接</th><th>链接广告消耗&ROI 更多指标</th><th>成交转化 更多指标</th></tr>
      </thead>
      <tbody>
        <tr><td>链接A</td><td>1.2</td><td>10</td></tr>
      </tbody>
    </table>
  `);
  try {
    const skill = {
      id: "skill_changed",
      type: "derived-column",
      source: {
        id: "source_changed",
        selector: "#orders",
        tableIndex: 0,
        headers: ["店铺链接", "链接ROI分析 更多指标", "成交转化 更多指标"]
      },
      selectedColumns: [
        { header: "链接ROI分析 更多指标", normalizedHeader: "链接roi分析更多指标", occurrence: 1 }
      ]
    };
    const blockedListSignature = buildSourceChangeRetrySignature({
      status: "changed",
      actualHeaders: ["店铺链接", "链接广告消耗&ROI 更多指标", "成交转化 更多指标"],
      candidateCount: 1,
      ambiguous: false
    });
    assert.equal(shouldRetryBlockedRuntimeForListChange({
      skillId: "skill_changed",
      status: "blocked",
      blockedReason: "source-changed",
      blockedUntil: Number.MAX_SAFE_INTEGER,
      blockedListSignature
    }, skill), false);
  } finally {
    cleanup();
  }
});

test("source-changed blocked runtime retries when visible headers change", () => {
  const { shouldRetryBlockedRuntimeForListChange, buildSourceChangeRetrySignature } = runtimeTest;
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr><th>店铺链接</th><th>链接广告消耗&ROI 更多指标</th><th>成交转化 更多指标</th></tr>
      </thead>
      <tbody>
        <tr><td>链接A</td><td>1.2</td><td>10</td></tr>
      </tbody>
    </table>
  `);
  try {
    const skill = {
      id: "skill_changed",
      type: "derived-column",
      source: {
        id: "source_changed",
        selector: "#orders",
        tableIndex: 0,
        headers: ["店铺链接", "链接ROI分析 更多指标", "成交转化 更多指标"]
      },
      selectedColumns: [
        { header: "链接ROI分析 更多指标", normalizedHeader: "链接roi分析更多指标", occurrence: 1 }
      ]
    };
    const blockedListSignature = buildSourceChangeRetrySignature({
      status: "changed",
      actualHeaders: ["店铺链接", "营销场景", "成交转化 更多指标"],
      candidateCount: 1,
      ambiguous: false
    });
    assert.equal(shouldRetryBlockedRuntimeForListChange({
      skillId: "skill_changed",
      status: "blocked",
      blockedReason: "source-changed",
      blockedUntil: Number.MAX_SAFE_INTEGER,
      blockedListSignature
    }, skill), true);
  } finally {
    cleanup();
  }
});

test("stable rendered blocked runtime is preserved", () => {
  const { shouldKeepStableRenderedRuntime } = runtimeTest;
  const cleanup = installDom(`
    <table id="orders">
      <tbody>
        <tr id="row">
          <td>A-1</td>
          <td data-web2ai-derived-column="skill_blocked">当前页面已触发访问保护；列表变化后会重新判断，但模型请求仍受当前页面总额度限制。</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    assert.equal(shouldKeepStableRenderedRuntime({
      skillId: "skill_blocked",
      status: "blocked",
      root: document.querySelector("#orders")
    }), true);
  } finally {
    cleanup();
  }
});

test("stale manual runtime can be cleared when current page no longer has result rows", () => {
  const { clearStaleRuntimeController } = runtimeTest;
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr><th>订单号</th><th data-web2ai-derived-column-header="skill_manual" data-web2ai-derived-column="skill_manual">AI结论</th></tr>
      </thead>
      <tbody>
        <tr id="row">
          <td>A-1</td>
          <td data-web2ai-derived-column="skill_manual">优先处理</td>
        </tr>
      </tbody>
    </table>
  `);
  try {
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column]").length, 2);
    assert.equal(clearStaleRuntimeController({
      skillId: "skill_manual",
      root: document.querySelector("#orders"),
      status: "complete",
      runOptions: null,
      blockedUntil: 0,
      blockedReason: ""
    }, "test"), true);
    assert.equal(document.querySelectorAll("[data-web2ai-derived-column]").length, 0);
  } finally {
    cleanup();
  }
});

test("runtime rows resolve selected columns and keep duplicate rows grouped by fingerprint", () => {
  const cleanup = installDom(`
    <table id="orders">
      <thead>
        <tr><th>选择</th><th>订单号</th><th>金额</th><th>状态</th></tr>
      </thead>
      <tbody>
        <tr><td></td><td>A-1</td><td>100</td><td>待处理</td></tr>
        <tr><td></td><td>A-2</td><td>100</td><td>待处理</td></tr>
        <tr><td></td><td>A-3</td><td>200</td><td>已完成</td></tr>
      </tbody>
    </table>
  `);
  try {
    const skill = {
      id: "skill_1",
      type: "derived-column",
      selectedColumns: [
        { header: "金额", normalizedHeader: "金额", occurrence: 1 },
        { header: "状态", normalizedHeader: "状态", occurrence: 1 }
      ],
      execution: { maxRows: 100, maxBatchRows: 20 }
    };
    const { buildRuntimeRows, buildRuntimeUniqueRows } = runtimeTest;
    const table = document.querySelector("#orders");
    const runtimeRows = buildRuntimeRows({
      skill,
      table,
      headers: ["选择", "订单号", "金额", "状态"]
    });
    assert.equal(runtimeRows.rows.length, 3);
    assert.deepEqual(runtimeRows.rows[0].selectedValues, ["100", "待处理"]);
    const uniqueRows = buildRuntimeUniqueRows({
      rows: runtimeRows.rows,
      selectedColumns: runtimeRows.selectedColumns,
      skill: {
        id: "skill_1",
        sources: [{ id: "source_1" }]
      }
    });
    assert.equal(uniqueRows.length, 2);
    assert.equal(uniqueRows[0].instances.length, 2);
    assert.equal(uniqueRows[0].fingerprint, buildDerivedColumnRowFingerprint(["100", "待处理"]));
  } finally {
    cleanup();
  }
});

test("runtime failure map keeps first failure per fingerprint", () => {
  const { buildRuntimeFailureMap } = runtimeTest;
  const map = buildRuntimeFailureMap([
    { fingerprint: "sha256:a", error: "缺少结果" },
    { fingerprint: "sha256:a", error: "重复" },
    { fingerprint: "sha256:b", error: "未知 fingerprint" }
  ]);
  assert.equal(map.get("sha256:a"), "缺少结果");
  assert.equal(map.get("sha256:b"), "未知 fingerprint");
});

test("runtime cache keys round-trip and analysis fingerprint changes with output config", () => {
  const base = {
    id: "skill_1",
    revision: 2,
    type: "derived-column",
    sources: [{ id: "source_1" }],
    selectedColumns: [{ header: "金额", normalizedHeader: "金额", occurrence: 1 }],
    analysisMethod: { description: "" },
    defaultMethodVersion: 1,
    output: { columnName: "AI结论", position: "before-first-selected-column", maxChars: 120 }
  };
  const first = buildDerivedColumnAnalysisFingerprint({
    skill: base,
    sourceId: "source_1",
    modelId: "model_a",
    resultSchemaVersion: 1
  });
  const second = buildDerivedColumnAnalysisFingerprint({
    skill: {
      ...base,
      output: { ...base.output, maxChars: 220 }
    },
    sourceId: "source_1",
    modelId: "model_a",
    resultSchemaVersion: 1
  });
  assert.notEqual(first, second);
  const cacheKey = buildDerivedColumnCacheKey(first, "sha256:row");
  assert.deepEqual(parseDerivedColumnCacheKey(cacheKey), {
    analysisFingerprint: first,
    rowFingerprint: "sha256:row"
  });
});

test("runtime cache entries can be written then read back immediately", async () => {
  await writeDerivedColumnCacheEntries("sha256:analysis", [
    { rowFingerprint: "sha256:row-1", conclusion: "优先处理", needsAttention: true },
    { rowFingerprint: "sha256:row-2", conclusion: "正常" }
  ]);
  const cached = await readDerivedColumnCacheEntries("sha256:analysis", [
    "sha256:row-1",
    "sha256:row-2"
  ]);
  assert.equal(cached.get("sha256:row-1")?.conclusion, "优先处理");
  assert.equal(cached.get("sha256:row-1")?.needsAttention, true);
  assert.equal(cached.get("sha256:row-2")?.conclusion, "正常");
  assert.equal(cached.get("sha256:row-2")?.needsAttention, false);
});

test("runtime cache can restore a previously analyzed page without another model request", async () => {
  const analysisFingerprint = "sha256:return-page-analysis";
  await writeDerivedColumnCacheEntries(analysisFingerprint, [
    { rowFingerprint: "sha256:page1-row-1", conclusion: "第一页结果1" },
    { rowFingerprint: "sha256:page1-row-2", conclusion: "第一页结果2" }
  ]);
  const restored = await readDerivedColumnCacheEntries(analysisFingerprint, [
    "sha256:page1-row-1",
    "sha256:page1-row-2"
  ]);
  assert.deepEqual(
    Array.from(restored.entries()).map(([fingerprint, item]) => [fingerprint, item.conclusion]),
    [
      ["sha256:page1-row-1", "第一页结果1"],
      ["sha256:page1-row-2", "第一页结果2"]
    ]
  );
});

test("runtime controller resolves broadcast skill without relying on STATE.skills", async () => {
  const { resolveControllerSkill } = runtimeTest;
  const controllerSkill = {
    id: "skill_broadcast",
    type: "derived-column",
    name: "订单风险",
    selectedColumns: [{ header: "金额", normalizedHeader: "金额", occurrence: 1 }]
  };
  const resolved = resolveControllerSkill({
    skillId: "skill_broadcast",
    skill: controllerSkill
  });
  assert.equal(resolved, controllerSkill);
});

test("runtime page-level guard enters cooldown after too many requests", () => {
  const {
    buildPageRequestGuardKey,
    buildPageRequestListGuardKey,
    canRequestDerivedRuntimePage,
    normalizeRuntimeRunOptions,
    recordDerivedRuntimePageRequest
  } = runtimeTest;
  const guardKey = buildPageRequestGuardKey("model_a");
  const listGuardKeyA = buildPageRequestListGuardKey("model_a", "list_a");
  const listGuardKeyB = buildPageRequestListGuardKey("model_a", "list_b");
  assert.equal(guardKey, "https://example.test/orders::model_a");
  assert.equal(listGuardKeyA, "https://example.test/orders::model_a::list_a");
  assert.equal(listGuardKeyB, "https://example.test/orders::model_a::list_b");
  const first = canRequestDerivedRuntimePage(guardKey, { windowMs: 60 * 1000, maxRequests: 5 });
  assert.equal(first.allowed, true);
  recordDerivedRuntimePageRequest(guardKey, 60 * 1000);
  recordDerivedRuntimePageRequest(guardKey, 60 * 1000);
  recordDerivedRuntimePageRequest(guardKey, 60 * 1000);
  recordDerivedRuntimePageRequest(guardKey, 60 * 1000);
  recordDerivedRuntimePageRequest(guardKey, 60 * 1000);
  const blocked = canRequestDerivedRuntimePage(guardKey, { windowMs: 60 * 1000, maxRequests: 5 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "limit");
  assert.ok(blocked.cooldownUntil > Date.now());
  assert.deepEqual(normalizeRuntimeRunOptions({
    manual: true,
    bypassPageGuard: true,
    ignoreCache: true,
    ignoreRecentResult: true
  }), {
    manual: true,
    bypassPageGuard: true,
    ignoreCache: true,
    ignoreRecentResult: true
  });
});

test("changing list signature does not reset the page-level request budget", () => {
  const {
    buildPageRequestGuardKey,
    buildPageRequestListGuardKey,
    canRequestDerivedRuntimePage,
    recordDerivedRuntimePageRequest
  } = runtimeTest;
  const pageGuardKey = buildPageRequestGuardKey("model_budget");
  const pageListGuardKey1 = buildPageRequestListGuardKey("model_budget", "page_1_rows");
  const pageListGuardKey2 = buildPageRequestListGuardKey("model_budget", "page_2_rows");
  assert.notEqual(pageListGuardKey1, pageListGuardKey2);
  recordDerivedRuntimePageRequest(pageGuardKey, 60 * 1000);
  const blockedAfterListChange = canRequestDerivedRuntimePage(pageGuardKey, {
    windowMs: 60 * 1000,
    maxRequests: 1
  });
  assert.equal(blockedAfterListChange.allowed, false);
  assert.equal(blockedAfterListChange.reason, "limit");
});

test("resolveDerivedInsertIndex uses positionIndex for at-column", () => {
  const { resolveDerivedInsertIndex } = runtimeTest;
  assert.equal(resolveDerivedInsertIndex(
    [{ index: 2 }, { index: 5 }],
    { position: "at-column", positionIndex: 7 }
  ), 7);
});

test("resolveDerivedInsertIndex returns max+1 for after-last-selected-column", () => {
  const { resolveDerivedInsertIndex } = runtimeTest;
  assert.equal(resolveDerivedInsertIndex(
    [{ index: 2 }, { index: 5 }],
    { position: "after-last-selected-column" }
  ), 6);
});

test("resolveDerivedInsertIndex returns min for before-first-selected-column", () => {
  const { resolveDerivedInsertIndex } = runtimeTest;
  assert.equal(resolveDerivedInsertIndex(
    [{ index: 2 }, { index: 5 }],
    { position: "before-first-selected-column" }
  ), 2);
});

test("resolveDerivedInsertIndex defaults to before-first when position is unknown", () => {
  const { resolveDerivedInsertIndex } = runtimeTest;
  assert.equal(resolveDerivedInsertIndex(
    [{ index: 2 }, { index: 5 }],
    { position: "unknown" }
  ), 2);
});

test("resolveDerivedInsertIndex returns 0 when no valid selectedColumns", () => {
  const { resolveDerivedInsertIndex } = runtimeTest;
  assert.equal(resolveDerivedInsertIndex([], { position: "after-last-selected-column" }), 0);
  assert.equal(resolveDerivedInsertIndex(
    [{ header: "无" }],
    { position: "before-first-selected-column" }
  ), 0);
});
