/**
 * E2E: business-tab skill source status (the 7th scenario).
 *
 * A page exposes two business tables on separate tabs (计划视图 / 链接视图).
 * Two locator (v2) derived-column skills are bound to those tables by header
 * fingerprint, with intentionally-missing positional selectors so the source
 * validator must fall back to exact-header matching. With auto-run disabled,
 * no model request is made — this is a pure UI/source-status test.
 *
 * Expected behaviour (DESIGN §10):
 *   - 计划视图 active  → 计划表定位 = available, 链接表定位 = changed
 *   - switch to 链接视图 → 链接表定位 = available, 计划表定位 = changed
 *
 * This is a self-contained scenario isolated from the long-running
 * chrome-extension.mjs suite so it cannot inherit cross-section state.
 *
 * Run:
 *   node tests/e2e/business-tab-source-status.mjs
 *   E2E_HEADLESS=1 E2E_NO_SANDBOX=1 node tests/e2e/business-tab-source-status.mjs
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

// --- fixture: two business tables behind tab switches ----------------------
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

// --- stage an unpacked extension copy in a temp dir ------------------------
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web2ai-bt-"));
const extension = path.join(temp, "extension");
await fs.mkdir(extension);
await fs.cp(path.join(ROOT, "src"), path.join(extension, "src"), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = ["<all_urls>"];
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

// --- local server: serves the tabbed fixture (+ a noop model endpoint) ------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/skill-source-tabs" ? skillSourceTabsFixture : "<h1>noop</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// --- a locator (v2) derived-column skill bound by header fingerprint --------
const makeLocatorDerivedSkill = ({ id, name, pageUrl, selector, headers, selectedColumns }) => {
  const source = {
    id: `${id}-source`,
    pageKey: pageUrl,
    frameUrl: pageUrl,
    selector,
    selectorStrength: "positional",
    tableIndex: 0,
    locatorVersion: 2,
    componentType: "art-table",
    headers,
    headerFingerprint: headers.map((h) => String(h || "").replace(/\s+/g, "").toLowerCase()).join("|"),
    businessTabTitle: "广告智能投放控制台"
  };
  return {
    id,
    type: "derived-column",
    name,
    revision: 1,
    version: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

const PLAN_HEADERS = ["序号", "计划预算及消耗", "计划转化 更多指标", "计划历史ROI 更多指标"];
const LINK_HEADERS = ["序号", "店铺链接 展示设置", "链接ROI分析 更多指标", "广告直接成交占比 更多指标"];
const tabbedPage = `${url}skill-source-tabs`;

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
const readSkillStatuses = (page) => page.$eval("#web2ai_overlay_host", (host) =>
  Array.from(host.shadowRoot.querySelectorAll(".skillCard")).map((card) => ({
    name: Array.from(card.querySelector(".skillTitle")?.childNodes || [])
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || "")
      .join("")
      .trim(),
    statusClass: Array.from(card.querySelector(".skillStatus")?.classList || []).join(" "),
    statusText: card.querySelector(".skillStatus")?.textContent?.trim() || ""
  })));
const waitForSkillStatusClass = async (page, skillName, statusClass) => {
  try {
    await page.waitForFunction(
      ({ expectedSkillName, expectedStatusClass }) => {
        const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
        const card = Array.from(shadow?.querySelectorAll(".skillCard") || [])
          .find((node) => node.querySelector(".skillTitle")?.textContent?.includes(expectedSkillName));
        const status = card?.querySelector(".skillStatus");
        return Boolean(status && status.classList.contains(expectedStatusClass));
      },
      { timeout: 30000, polling: 100 },
      { expectedSkillName: skillName, expectedStatusClass: statusClass }
    );
  } catch (error) {
    const statuses = await readSkillStatuses(page);
    throw new Error(`skill "${skillName}" did not reach "${statusClass}": ${JSON.stringify(statuses)}`, { cause: error });
  }
};

try {
  log("storing locator skills");
  await setStoredSkills([
    makeLocatorDerivedSkill({ id: "plan-locator-skill", name: "计划表定位", pageUrl: tabbedPage, selector: "#missing-plan-selector", headers: PLAN_HEADERS, selectedColumns: ["计划预算及消耗", "计划转化 更多指标"] }),
    makeLocatorDerivedSkill({ id: "link-locator-skill", name: "链接表定位", pageUrl: tabbedPage, selector: "#missing-link-selector", headers: LINK_HEADERS, selectedColumns: ["链接ROI分析 更多指标", "广告直接成交占比 更多指标"] })
  ]);

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[test][pageerror] ${e.message}`));
  log("opening tabbed page");
  await page.goto(tabbedPage);
  await page.waitForSelector("#web2ai_overlay_host");
  await openSkillsPanel(page);

  log("plan tab active: expect 计划表定位 available / 链接表定位 changed");
  await waitForSkillStatusClass(page, "计划表定位", "available");
  await waitForSkillStatusClass(page, "链接表定位", "changed");
  {
    const statuses = await readSkillStatuses(page);
    assert.ok(statuses.find((s) => s.name === "计划表定位" && s.statusClass.includes("available")), `initial: 计划表定位 must be available: ${JSON.stringify(statuses)}`);
    assert.ok(statuses.find((s) => s.name === "链接表定位" && s.statusClass.includes("changed")), `initial: 链接表定位 must be changed: ${JSON.stringify(statuses)}`);
  }

  log("switch to 链接视图");
  await page.click(".link-realTab");
  log("link tab active: expect 链接表定位 available / 计划表定位 changed");
  await waitForSkillStatusClass(page, "链接表定位", "available");
  await waitForSkillStatusClass(page, "计划表定位", "changed");
  {
    const statuses = await readSkillStatuses(page);
    assert.ok(statuses.find((s) => s.name === "链接表定位" && s.statusClass.includes("available")), `after switch: 链接表定位 must be available: ${JSON.stringify(statuses)}`);
    assert.ok(statuses.find((s) => s.name === "计划表定位" && s.statusClass.includes("changed")), `after switch: 计划表定位 must be changed: ${JSON.stringify(statuses)}`);
  }

  console.log("[test] business-tab source status passed");
  console.log("PASS business-tab-source-status");
} catch (error) {
  console.error(`[test] FAILED: ${error?.message ?? error}`);
  console.log("FAIL business-tab-source-status");
  process.exitCode = 1;
} finally {
  clearTimeout(HARD_TIMEOUT);
  try { await browser.close(); } catch {}
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode || 0);
}
