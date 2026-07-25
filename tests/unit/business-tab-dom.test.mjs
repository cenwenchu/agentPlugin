import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// state.js 导入时即访问 window，须在任何 src 模块导入前装好全局 DOM
const bootstrap = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://www.erp321.com/" });
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
globalThis.Element = bootstrap.window.Element;
globalThis.Node = bootstrap.window.Node;

function installDom(html, url = "https://www.erp321.com/") {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.location = dom.window.location;
  return () => {
    globalThis.window = bootstrap.window;
    globalThis.document = bootstrap.window.document;
    globalThis.Element = bootstrap.window.Element;
    globalThis.Node = bootstrap.window.Node;
    globalThis.location = bootstrap.window.location;
  };
}

const {
  isJtv1LikePage, findBusinessTabElements, businessTabTitle, businessTabActive,
  businessTabTitles, closestBusinessTab, jtv1TabDirectUrl, jtv1SourceDirectUrl
} = await import("../../src/content/business-tab-dom.js");

test("reads realTab business tabs regardless of jtv1 features", () => {
  const cleanup = installDom(`
    <div class="foo-realTab">订单管理</div>
    <div class="foo-realTab">销售出库</div>
  `);
  try {
    assert.deepEqual(businessTabTitles(), ["订单管理", "销售出库"]);
  } finally {
    cleanup();
  }
});

test("jtv1SourceDirectUrl: epaas source builds ?n= url from source origin", () => {
  const url = jtv1SourceDirectUrl("https://www.erp321.com/epaas", "采购单管理");
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://www.erp321.com/epaas");
  assert.equal(parsed.searchParams.get("n"), "采购单管理");
});

test("jtv1SourceDirectUrl: epaas source with existing query still rebuilds cleanly", () => {
  const url = jtv1SourceDirectUrl("https://www.erp321.com/epaas?n=%E5%94%AE%E5%90%8E", "售后");
  assert.equal(new URL(url).searchParams.get("n"), "售后");
});

test("jtv1SourceDirectUrl: non-epaas source (sc.scm121.com) returns empty", () => {
  // “技能页面地址无效”修复核心：sc 站无 /epaas 路径，必须返回空让调用方回退原 pageUrl
  assert.equal(jtv1SourceDirectUrl("https://sc.scm121.com/dataCenter/adConsole/home", "广告智能投放控制台"), "");
});

test("jtv1SourceDirectUrl: invalid or empty inputs return empty", () => {
  assert.equal(jtv1SourceDirectUrl("", "标题"), "");
  assert.equal(jtv1SourceDirectUrl("not-a-url", "标题"), "");
  assert.equal(jtv1SourceDirectUrl("https://www.erp321.com/epaas", ""), "");
  assert.equal(jtv1SourceDirectUrl("ftp://x.com/epaas", "标题"), "");
});

test("jtv1TabDirectUrl builds ?n=title url without affecting pageKey", () => {
  const cleanup = installDom(`<iframe src="app/scm/purchase/purchasemode.aspx"></iframe>`, "https://www.erp321.com/epaas");
  try {
    const url = jtv1TabDirectUrl("采购单管理");
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://www.erp321.com/epaas");
    assert.equal(parsed.searchParams.get("n"), "采购单管理");
    // 空标题返回空串
    assert.equal(jtv1TabDirectUrl(""), "");
    assert.equal(jtv1TabDirectUrl("   "), "");
  } finally {
    cleanup();
  }
});

test("reads jtv1 ant Tabs only when jtv1 page feature present", () => {
  const jtv1Tabs = `
    <iframe id="iframe-43" src="app/scm/purchase/purchasemode.aspx?_c=jst-epaas&epaas=true"></iframe>
    <div class="ant-tabs-nav-list">
      <div role="tab" aria-selected="false" id="rc-tabs-0-tab-132" class="ant-tabs-tab-btn">订单</div>
      <div role="tab" aria-selected="true" id="rc-tabs-0-tab-43" class="ant-tabs-tab-btn">采购单管理</div>
    </div>
  `;
  // 有 jtv1 特征（iframe src 为 .aspx）→ 识别 ant Tabs
  let cleanup = installDom(jtv1Tabs);
  try {
    assert.equal(isJtv1LikePage(), true);
    const tabs = findBusinessTabElements();
    assert.deepEqual(tabs.map(businessTabTitle), ["订单", "采购单管理"]);
    const active = tabs.find(businessTabActive);
    assert.equal(businessTabTitle(active), "采购单管理");
  } finally {
    cleanup();
  }
  // 无 jtv1 特征也无 realTab → 不识别 ant Tabs（避免普通站点误判）
  cleanup = installDom(`<div role="tab" aria-selected="true" class="ant-tabs-tab-btn">采购单管理</div>`);
  try {
    assert.equal(isJtv1LikePage(), false);
    assert.deepEqual(businessTabTitles(), []);
  } finally {
    cleanup();
  }
});

test("realTab takes precedence over ant Tabs when both present", () => {
  const cleanup = installDom(`
    <iframe src="app/scm/purchase/purchasemode.aspx"></iframe>
    <div class="x-realTab">老框架页签</div>
    <div role="tab" class="ant-tabs-tab-btn">ant页签</div>
  `);
  try {
    assert.deepEqual(businessTabTitles(), ["老框架页签"]);
  } finally {
    cleanup();
  }
});

test("closestBusinessTab resolves ant tab from event target", () => {
  const cleanup = installDom(`
    <iframe src="app/scm/purchase/purchasemode.aspx"></iframe>
    <div role="tab" aria-selected="false" class="ant-tabs-tab-btn" id="t"><span class="inner">采购单管理</span></div>
  `);
  try {
    const inner = document.querySelector(".inner");
    const tab = closestBusinessTab(inner);
    assert.ok(tab);
    assert.equal(tab.kind, "ant");
    assert.equal(businessTabTitle(tab), "采购单管理");
  } finally {
    cleanup();
  }
});

test("isJtv1LikePage: /epaas URL path matches even without DOM features", () => {
  // 框架首页：只有欢迎页签 iframe + 页签栏，无 #_jt
  const cleanup = installDom(`<div>框架首页</div>`, "https://www.erp321.com/epaas");
  try {
    assert.equal(isJtv1LikePage(), true);
  } finally {
    cleanup();
  }
});

test("isJtv1LikePage: /epaas with query (?n=) still matches", () => {
  const cleanup = installDom(`<div>业务页</div>`, "https://www.erp321.com/epaas?n=%E9%87%87%E8%B4%AD");
  try {
    assert.equal(isJtv1LikePage(), true);
  } finally {
    cleanup();
  }
});

test("isJtv1LikePage: epaas-tab iframe marks jtv1 even off /epaas path", () => {
  const cleanup = installDom(`<iframe id="epaas-tab-welcome-page" src="//src.erp321.com/home/"></iframe>`, "https://www.erp321.com/home");
  try {
    assert.equal(isJtv1LikePage(), true);
  } finally {
    cleanup();
  }
});

test("isJtv1LikePage: non-epaas site without features returns false", () => {
  const cleanup = installDom(`<div>普通站点</div>`, "https://tool.jushuitan.com/ticket");
  try {
    assert.equal(isJtv1LikePage(), false);
  } finally {
    cleanup();
  }
});

test("isJtv1LikePage: sc.scm121.com business path (non-/epaas, no DOM) returns false", () => {
  // sc 分销版 URL 不是 /epaas，若无 #_jt/.aspx 特征不应误判
  const cleanup = installDom(`<div class="ant-tabs-tab-btn">广告智能投放控制台</div>`, "https://sc.scm121.com/dataCenter/adConsole/home");
  try {
    assert.equal(isJtv1LikePage(), false);
  } finally {
    cleanup();
  }
});
