#!/usr/bin/env node
/**
 * E2E: jtv1（聚水潭 epaas 多页签框架）技能按业务页签标题归属与分组。
 *
 * 受 127.0.0.1 host 限制无法命中 location.pathname === /epaas 的 URL 判定，
 * fixture 用 DOM 特征（#_jt）让 isJtv1LikePage() 走 DOM 兜底分支命中——
 * 这正是 background/content 在真实 erp321.com 之外识别 jtv1 的路径。
 *
 * fixture 提供聚水潭 ant Tabs 页签栏（.ant-tabs-tab-btn + role=tab +
 * aria-controls + aria-selected），两个业务页签：采购单管理 / 售后。
 * 预置两个技能，各自 source 带不同 businessTabTitle，验证：
 *   1. 激活「采购单管理」时，「当前页面」区只显示采购单技能；「售后」技能
 *      出现在「其他页面技能」的【售后】分组（分组 key = tab:标题）。
 *   2. 带页签标题的 source 跳过技能级 pageKey 兜底分组——分组列表里只有
 *      【售后】一项，不出现 127.0.0.1 顶层页面分组，技能不重复出现。
 *   3. 点击切到「售后」页签后，当前页变为售后技能，采购单技能进
 *      【采购单管理】分组。
 *
 * 数据源定位校验（available/changed）不影响归属与分组，故 source 用缺失
 * 选择器，避免引入表格识别时序。
 *
 * Run:
 *   node tests/e2e/jtv1-tab-skill-grouping.mjs
 *   E2E_HEADLESS=1 E2E_NO_SANDBOX=1 node tests/e2e/jtv1-tab-skill-grouping.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeFs from "node:fs";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.E2E_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
].filter(Boolean);
const CHROME = (await Promise.all(
  chromeCandidates.map(async (candidate) => (await nodeFs.promises.access(candidate).then(() => candidate).catch(() => "")))
)).find(Boolean);
if (!CHROME) {
  console.error("[test] Chrome not found. Set CHROME_PATH or run on macOS/Linux with Chrome installed.");
  process.exit(1);
}
const HEADLESS = /^(1|true)$/i.test(process.env.E2E_HEADLESS || "") ? "new" : false;
const log = (step) => console.log(`[test] ${step}`);

// --- fixture: jtv1 DOM 特征（#_jt）+ 聚水潭 ant Tabs 两个业务页签 -----------
// 注意不能出现任何以 -realTab 结尾 / 含 realTab 的 class，否则会命中老框架
// realTab 分支而绕过 ant Tabs 识别。
const jtv1TabsFixture = `<!doctype html><meta charset="utf-8"><title>聚水潭 epaas 模拟页</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:16px}
    .ant-tabs-nav-list{display:flex;gap:8px;margin-bottom:12px}
    .ant-tabs-tab{padding:6px 14px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer}
    .ant-tabs-tab[aria-selected="true"]{background:#2563eb;color:#fff}
    .ant-tabs-tab-btn{background:none;border:none;cursor:pointer;font-size:14px;color:inherit}
  </style>
  <div id="_jt" style="display:none"></div>
  <div class="ant-tabs">
    <div class="ant-tabs-nav">
      <div class="ant-tabs-nav-list">
        <div id="tab-purchase" class="ant-tabs-tab ant-tabs-tab-active" role="tab" aria-selected="true" aria-controls="panel-purchase"><button type="button" class="ant-tabs-tab-btn">采购单管理</button></div>
        <div id="tab-aftersale" class="ant-tabs-tab" role="tab" aria-selected="false" aria-controls="panel-aftersale"><button type="button" class="ant-tabs-tab-btn">售后</button></div>
      </div>
    </div>
  </div>
  <section id="panel-purchase">采购单管理内容区</section>
  <section id="panel-aftersale">售后内容区</section>
  <script>
    const tabs = Array.from(document.querySelectorAll('.ant-tabs-tab'));
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      tabs.forEach((item) => {
        const active = item === tab;
        item.setAttribute('aria-selected', active ? 'true' : 'false');
        item.classList.toggle('ant-tabs-tab-active', active);
      });
    }));
  <\/script>`;

// --- stage an unpacked extension copy in a temp dir ------------------------
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web2ai-jtv1-group-"));
const extension = path.join(temp, "extension");
await fs.mkdir(extension);
await fs.cp(path.join(ROOT, "src"), path.join(extension, "src"), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = ["<all_urls>"];
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

// --- local server: serves the jtv1 tabs fixture ------------------------------
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/jtv1-tabs" ? jtv1TabsFixture : "<h1>noop</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const jtv1Page = `${url}jtv1-tabs`;

// --- 技能：各绑一个带 businessTabTitle 的 source（缺失选择器，校验状态不影响分组）---
const makeTabBoundSkill = ({ id, name, businessTabTitle, headers, selectedColumns }) => {
  const source = {
    id: `${id}-source`,
    pageKey: jtv1Page,
    pageUrl: jtv1Page,
    frameUrl: jtv1Page,
    selector: `#missing-${id}-selector`,
    selectorStrength: "positional",
    tableIndex: 0,
    locatorVersion: 2,
    componentType: "art-table",
    headers,
    headerFingerprint: headers.map((h) => String(h || "").replace(/\s+/g, "").toLowerCase()).join("|"),
    businessTabTitle
  };
  return {
    id,
    type: "derived-column",
    name,
    revision: 1,
    version: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pageKey: jtv1Page,
    pageUrl: jtv1Page,
    pageTitle: "聚水潭 epaas 模拟页",
    analysisMethod: { description: "根据字段给出简短结论" },
    output: { columnName: "AI结论", position: "before-first-selected-column", maxChars: 1000 },
    trigger: { mode: "page-load", autoRunEnabled: false },
    execution: { scope: "current-page", maxRows: 100, maxBatchRows: 20 },
    source,
    sources: [source],
    selectedColumns: selectedColumns.map((h, i) => ({
      index: i,
      header: h,
      normalizedHeader: String(h || "").replace(/\s+/g, "").toLowerCase(),
      occurrence: 1
    }))
  };
};

const PURCHASE_SKILL = makeTabBoundSkill({
  id: "purchase-tab-skill",
  name: "采购单汇总",
  businessTabTitle: "采购单管理",
  headers: ["序号", "采购单号", "供应商", "金额"],
  selectedColumns: ["采购单号", "金额"]
});
const AFTERSALE_SKILL = makeTabBoundSkill({
  id: "aftersale-tab-skill",
  name: "售后分析",
  businessTabTitle: "售后",
  headers: ["序号", "售后单号", "原因", "状态"],
  selectedColumns: ["售后单号", "原因"]
});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  protocolTimeout: 600000,
  pipe: true,
  enableExtensions: [extension],
  // Restricted/sandboxed runners (CI, automated agents) cannot initialize
  // Chrome's own setuid sandbox and crash before the extension loads. Gate the
  // escape hatch behind an explicit env var; dev machines keep the sandbox.
  args: /^(1|true)$/i.test(process.env.E2E_NO_SANDBOX || "")
    ? ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    : []
});

// Safety net so a regression cannot hang the runner indefinitely.
const HARD_TIMEOUT = setTimeout(() => {
  console.error("[test] HARD TIMEOUT 120s - aborting");
  process.exit(3);
}, 120000);
HARD_TIMEOUT.unref?.();

const isExtensionServiceWorker = (target) => target.type() === "service_worker" && /^chrome-extension:\/\/[^/]+\/src\/background\.js$/.test(target.url());
// An MV3 service worker is stopped after ~30s of inactivity; a handle captured
// once goes stale and the next evaluate blocks until the protocolTimeout.
// Re-resolve the current target before every call.
const freshWorker = async () => {
  const target = await browser.waitForTarget(isExtensionServiceWorker, { timeout: 15000 }).catch(() => null);
  const handle = target ? await target.worker().catch(() => null) : null;
  if (!handle) throw new Error("extension service worker is not available");
  return handle;
};
const setStoredSkills = async (skills) => {
  // Give the freshly started worker a moment to expose chrome.storage.
  await new Promise((r) => setTimeout(r, 1500));
  const worker = await freshWorker();
  await Promise.race([
    worker.evaluate(async (nextSkills) => {
      await chrome.storage.local.set({ web2aiSkills: nextSkills });
    }, skills),
    new Promise((_, reject) => setTimeout(() => reject(new Error("setStoredSkills timed out")), 15000))
  ]);
};

const openSkillsPanel = async (page) => {
  // The overlay starts hidden on a fresh page; open it via the launcher so the
  // 技能 tab is reachable before waiting on it.
  await page.$eval("#web2ai_overlay_host", (host) => {
    if (host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")) {
      document.querySelector("#web2ai_launcher_fab")?.click();
    }
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((b) => b.textContent?.trim() === "技能")?.click();
  });
};

// 面板快照：当前页签标签、当前页技能卡、其他页面技能分组。
// 点击业务页签 300ms 后顶层点击监听会收起面板，但 shadow DOM 节点保留
// （.wrap 只加 hidden class），因此收起状态下依然可读。
const readPanelSnapshot = (page) => page.$eval("#web2ai_overlay_host", (host) => {
  const shadow = host.shadowRoot;
  const skillNameOf = (card) => Array.from(card.querySelector(".skillTitle")?.childNodes || [])
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent || "")
    .join("")
    .trim();
  return {
    currentLabel: (shadow.querySelector(".skillCurrentLabelText")?.textContent || "").replace(/\s+/g, ""),
    summary: (shadow.querySelector(".skillSummaryTitleText")?.textContent || "").replace(/\s+/g, ""),
    currentCards: Array.from(shadow.querySelectorAll(".skillCard")).map(skillNameOf),
    otherGroups: Array.from(shadow.querySelectorAll("#web2ai_skill_pages_wrap .skillPageLink")).map((link) => ({
      name: link.querySelector(".skillPageName")?.textContent?.trim() || "",
      count: link.querySelector(".skillPageCount")?.textContent?.trim() || ""
    }))
  };
});

const waitForPanelState = async (page, description, predicate) => {
  try {
    await page.waitForFunction(
      (checkSource) => {
        const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
        if (!shadow) return false;
        const skillNameOf = (card) => Array.from(card.querySelector(".skillTitle")?.childNodes || [])
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent || "")
          .join("")
          .trim();
        const snapshot = {
          currentLabel: (shadow.querySelector(".skillCurrentLabelText")?.textContent || "").replace(/\s+/g, ""),
          currentCards: Array.from(shadow.querySelectorAll(".skillCard")).map(skillNameOf),
          otherGroups: Array.from(shadow.querySelectorAll("#web2ai_skill_pages_wrap .skillPageLink")).map((link) => ({
            name: link.querySelector(".skillPageName")?.textContent?.trim() || "",
            count: link.querySelector(".skillPageCount")?.textContent?.trim() || ""
          }))
        };
        // eslint-disable-next-line no-eval
        return eval(`(${checkSource})`)(snapshot);
      },
      { timeout: 30000, polling: 100 },
      predicate.toString()
    );
  } catch (error) {
    const snapshot = await readPanelSnapshot(page).catch(() => null);
    throw new Error(`panel did not reach "${description}": ${JSON.stringify(snapshot)}`, { cause: error });
  }
};

try {
  log("storing tab-bound skills (采购单管理 / 售后)");
  await setStoredSkills([PURCHASE_SKILL, AFTERSALE_SKILL]);

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[test][pageerror] ${e.message}`));
  log("opening jtv1 tabs fixture");
  await page.goto(jtv1Page);
  await page.waitForSelector("#web2ai_overlay_host");
  await openSkillsPanel(page);

  log("phase 1: 采购单管理 active → 当前页只显示采购单技能，售后技能进【售后】分组");
  await waitForPanelState(page, "采购单管理 active grouping", (s) =>
    s.currentCards.includes("采购单汇总") && s.otherGroups.some((g) => g.name === "【售后】"));
  {
    const snapshot = await readPanelSnapshot(page);
    assert.deepEqual(snapshot.currentCards, ["采购单汇总"],
      `当前页面只能显示采购单技能: ${JSON.stringify(snapshot)}`);
    assert.ok(!snapshot.currentCards.includes("售后分析"),
      `售后技能不应出现在当前页面区: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.currentLabel.includes("当前页面（采购单管理"),
      `当前页名称应取激活页签标题: ${JSON.stringify(snapshot)}`);
    assert.deepEqual(snapshot.otherGroups, [{ name: "【售后】", count: "1" }],
      `其他页面技能应只有【售后】分组: ${JSON.stringify(snapshot)}`);
    assert.ok(!snapshot.otherGroups.some((g) => g.name.includes("采购单管理")),
      `激活页签分组不应出现在其他页面技能区: ${JSON.stringify(snapshot)}`);
    assert.ok(!snapshot.otherGroups.some((g) => g.name.includes("127.0.0.1") || g.name.includes("jtv1-tabs")),
      `带页签标题的 source 不应再产生 pageKey 兜底分组（技能重复）: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.summary.includes("全部技能2个"),
      `全部技能计数应为 2: ${JSON.stringify(snapshot)}`);
  }

  log("switch to 售后 tab");
  await page.click("#tab-aftersale .ant-tabs-tab-btn");

  log("phase 2: 售后 active → 当前页变为售后技能，采购单技能进【采购单管理】分组");
  await waitForPanelState(page, "售后 active grouping", (s) =>
    s.currentCards.includes("售后分析") && s.otherGroups.some((g) => g.name === "【采购单管理】"));
  {
    const snapshot = await readPanelSnapshot(page);
    assert.deepEqual(snapshot.currentCards, ["售后分析"],
      `切换后当前页面只能显示售后技能: ${JSON.stringify(snapshot)}`);
    assert.ok(!snapshot.currentCards.includes("采购单汇总"),
      `采购单技能不应出现在当前页面区: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.currentLabel.includes("当前页面（售后"),
      `当前页名称应切换到售后: ${JSON.stringify(snapshot)}`);
    assert.deepEqual(snapshot.otherGroups, [{ name: "【采购单管理】", count: "1" }],
      `其他页面技能应只有【采购单管理】分组: ${JSON.stringify(snapshot)}`);
    assert.ok(!snapshot.otherGroups.some((g) => g.name.includes("127.0.0.1") || g.name.includes("jtv1-tabs")),
      `切换后仍不应出现 pageKey 兜底分组: ${JSON.stringify(snapshot)}`);
  }

  console.log("[test] jtv1 tab skill grouping passed");
  console.log("PASS jtv1-tab-skill-grouping");
} catch (error) {
  console.error(`[test] FAILED: ${error?.message ?? error}`);
  console.log("FAIL jtv1-tab-skill-grouping");
  process.exitCode = 1;
} finally {
  clearTimeout(HARD_TIMEOUT);
  try { await browser.close(); } catch {}
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode || 0);
}
