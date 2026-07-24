import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import nodeFs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = chromeCandidates.find((c) => nodeFs.existsSync(c));
if (!CHROME) throw new Error("Chrome not found");
const HEADLESS = false;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web2ai-tabs-repro-"));
const extension = path.join(temp, "extension");
await fs.mkdir(extension);
await fs.cp(path.join(ROOT, "src"), path.join(extension, "src"), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = ["<all_urls>"];
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

const skillSourceTabsFixture = `<!doctype html><meta charset="utf-8"><title>Skill Source Tabs</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:16px}
    .tabs{display:flex;gap:8px;margin-bottom:12px}
    .tabs button[data-active="1"]{background:#2563eb;color:#fff}
    .pane[hidden]{display:none}
    .art-table{margin-bottom:16px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #d1d5db;padding:8px 10px;text-align:left}
  </style>
  <div class="tabs">
    <button class="plan-realTab" data-tab="plan" data-active="1" aria-selected="true">计划视图</button>
    <button class="link-realTab" data-tab="link" data-active="0" aria-selected="false">链接视图</button>
  </div>
  <section id="plan-pane" class="pane">
    <div class="art-table" id="plan-table">
      <table>
        <thead><tr><th>序号</th><th>计划预算及消耗</th><th>计划转化 更多指标</th><th>计划历史ROI 更多指标</th></tr></thead>
        <tbody><tr><td>1</td><td>100</td><td>9</td><td>1.2</td></tr></tbody>
      </table>
    </div>
  </section>
  <section id="link-pane" class="pane" hidden>
    <div class="art-table" id="link-table">
      <table>
        <thead><tr><th>序号</th><th>店铺链接 展示设置</th><th>链接ROI分析 更多指标</th><th>广告直接成交占比 更多指标</th></tr></thead>
        <tbody><tr><td>1</td><td>链接A</td><td>0.8</td><td>15%</td></tr></tbody>
      </table>
    </div>
  </section>
  <script>
    const applyTab = (name) => {
      document.querySelector('#plan-pane').hidden = name !== 'plan';
      document.querySelector('#link-pane').hidden = name !== 'link';
      document.querySelectorAll('.tabs button').forEach((button) => {
        const active = button.dataset.tab === name;
        button.dataset.active = active ? '1' : '0';
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    };
    document.querySelectorAll('.tabs button').forEach((button) => {
      button.addEventListener('click', () => applyTab(button.dataset.tab));
    });
    applyTab('plan');
  <\/script>`;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ choices: [{ message: { content: "E2E 分析完成" } }] }));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/skill-source-tabs" ? skillSourceTabsFixture : "<h1>noop</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  protocolTimeout: 600000,
  pipe: true,
  enableExtensions: [extension]
});

const HARD_TIMEOUT = setTimeout(async () => {
  console.error("[repro] HARD TIMEOUT 90s - aborting");
  try { await browser.close(); } catch {}
  process.exit(3);
}, 90000);
HARD_TIMEOUT.unref?.();

try {
  const extensionTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && /^chrome-extension:\/\/[^/]+\/src\/background\.js$/.test(target.url()),
    { timeout: 15000 }
  );
  const page = await browser.newPage();
  page.on("dialog", async (d) => { console.log(`[repro] DIALOG ${d.type()} ${d.message()}`); await d.accept().catch(() => {}); });
  page.on("pageerror", (e) => console.log(`[repro] PAGEERROR ${e.message}`));
  page.on("console", (m) => { const t = m.text(); if (/web2ai|error|Error|loop|Maximum/i.test(t)) console.log(`[repro][page] ${t}`); });

  const freshWorker = async () => {
    const sw = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && /^chrome-extension:\/\/[^/]+\/src\/background\.js$/.test(t.url()),
      { timeout: 5000 }
    ).catch(() => null);
    return sw ? await sw.worker().catch(() => null) : null;
  };
  const setStoredSkills = async (skills) => {
    await new Promise((r) => setTimeout(r, 2000));
    const w = await freshWorker();
    if (!w) throw new Error("no worker");
    const diag = await w.evaluate(() => ({ hasChrome: typeof chrome, hasStorage: typeof chrome?.storage, hasLocal: typeof chrome?.storage?.local }));
    console.log("[repro] worker diag:", JSON.stringify(diag));
    await Promise.race([
      w.evaluate(async (nextSkills) => {
        await chrome.storage.local.set({ web2aiSkills: nextSkills });
      }, skills),
      new Promise((_, r) => setTimeout(() => r(new Error("setSkills-timeout")), 15000))
    ]);
    console.log("[repro] skills stored");
  };

  const openSkillsPanel = async () => {
    await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));
    await page.$eval("#web2ai_overlay_host", (host) => {
      Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((b) => b.textContent?.trim() === "技能")?.click();
    });
  };
  const waitForSkillStatusClass = async (skillName, statusClass) => {
    try {
      await page.waitForFunction(({ n, s }) => {
        const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
        const cards = Array.from(shadow?.querySelectorAll(".skillCard") || []);
        const card = cards.find((node) => node.querySelector(".skillTitle")?.textContent?.includes(n));
        const status = card?.querySelector(".skillStatus");
        return Boolean(status && status.classList.contains(s));
      }, { timeout: 30000, polling: 100 }, { n: skillName, s: statusClass });
    } catch (e) {
      const statuses = await page.$eval("#web2ai_overlay_host", (host) => Array.from(host.shadowRoot.querySelectorAll(".skillCard")).map((c) => c.querySelector(".skillTitle")?.textContent?.trim() + ":" + c.querySelector(".skillStatus")?.textContent?.trim()));
      throw new Error(`skill "${skillName}" did not reach "${statusClass}": ${JSON.stringify(statuses)}`);
    }
  };
  const readSkillStatuses = () => page.$eval("#web2ai_overlay_host", (host) => Array.from(host.shadowRoot.querySelectorAll(".skillCard")).map((c) => ({
    name: c.querySelector(".skillTitle")?.textContent?.trim(),
    status: c.querySelector(".skillStatus")?.textContent?.trim()
  })));

  const makeLocatorDerivedSkill = (id, name, pageUrl, selector, headers, selectedColumns) => ({
    id, type: "derived-column", name, revision: 1, version: 3, createdAt: Date.now(), updatedAt: Date.now(),
    analysisMethod: { description: "x" }, output: { columnName: "AI结论", position: "before-first-selected-column", maxChars: 1000 },
    trigger: { mode: "page-load", autoRunEnabled: false }, execution: { scope: "current-page", maxRows: 100, maxBatchRows: 20 },
    source: { id: `${id}-source`, pageKey: pageUrl, frameUrl: pageUrl, selector, selectorStrength: "positional", tableIndex: 0, locatorVersion: 2, componentType: "art-table", headers, headerFingerprint: headers.map((h) => String(h || "").replace(/\s+/g, "").toLowerCase()).join("|"), businessTabTitle: "广告智能投放控制台" },
    sources: [{ id: `${id}-source`, pageKey: pageUrl, frameUrl: pageUrl, selector, selectorStrength: "positional", tableIndex: 0, locatorVersion: 2, componentType: "art-table", headers, headerFingerprint: headers.map((h) => String(h || "").replace(/\s+/g, "").toLowerCase()).join("|"), businessTabTitle: "广告智能投放控制台" }],
    selectedColumns: selectedColumns.map((h, i) => ({ index: i, header: h, normalizedHeader: String(h || "").replace(/\s+/g, "").toLowerCase(), occurrence: 1 }))
  });

  const tabbedSkillPage = `${url}skill-source-tabs`;
  console.log("[repro] storing skills");
  await setStoredSkills([
    makeLocatorDerivedSkill("plan-locator-skill", "计划表定位", tabbedSkillPage, "#missing-plan-selector", ["序号", "计划预算及消耗", "计划转化 更多指标", "计划历史ROI 更多指标"], ["计划预算及消耗", "计划转化 更多指标"]),
    makeLocatorDerivedSkill("link-locator-skill", "链接表定位", tabbedSkillPage, "#missing-link-selector", ["序号", "店铺链接 展示设置", "链接ROI分析 更多指标", "广告直接成交占比 更多指标"], ["链接ROI分析 更多指标", "广告直接成交占比 更多指标"])
  ]);
  console.log("[repro] goto");
  await page.goto(tabbedSkillPage);
  console.log("[repro] wait overlay");
  await page.waitForSelector("#web2ai_overlay_host");
  console.log("[repro] open panel");
  await openSkillsPanel(page);
  let cardDump;
  try {
    cardDump = await page.evaluate(() => {
      const host = document.querySelector("#web2ai_overlay_host");
      const root = host && (host.shadowRoot || host);
      const cards = Array.from(root.querySelectorAll(".skillCard, .skillBarItem, .skillListItem"));
      return cards.map((c) => ({
        cls: c.className,
        title: c.querySelector(".skillTitle, .skillName")?.textContent?.trim(),
        statusClass: c.querySelector(".skillStatus")?.className,
        statusText: c.querySelector(".skillStatus")?.textContent?.trim()
      }));
    });
  } catch (e) {
    cardDump = "dump-error:" + e.message;
  }
  console.log("[repro] CARDS:", JSON.stringify(cardDump));
  console.log("[repro] panel opened, wait plan available");
  await waitForSkillStatusClass("计划表定位", "available");
  console.log("[repro] plan available, wait link changed");
  await waitForSkillStatusClass("链接表定位", "changed");
  console.log("[repro] link changed, statuses=", JSON.stringify(await readSkillStatuses()));
  console.log("[repro] click link-realTab");
  await page.click(".link-realTab");
  console.log("[repro] wait link available");
  await waitForSkillStatusClass("链接表定位", "available");
  console.log("[repro] wait plan changed");
  await waitForSkillStatusClass("计划表定位", "changed");
  console.log("[repro] FINAL statuses=", JSON.stringify(await readSkillStatuses()));
  console.log("[repro] SUCCESS - no hang");
} catch (e) {
  console.error("[repro] FAILED:", e.message);
} finally {
  try { await browser.close(); } catch {}
  process.exit(0);
}
