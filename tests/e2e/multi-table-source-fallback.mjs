/**
 * E2E: multi-table source fallback (the 8th scenario).
 *
 * A page renders TWO `.art-table`s side by side. A locator (v2) derived-column
 * skill is bound with a positional selector (`#wrong-table`) that points at the
 * WRONG table, while its `headers` describe the OTHER table (`#target-table`).
 * The source validator must fall back from the drifted selector to exact-header
 * matching and recover the correct table, reporting status `available`
 * (DESIGN §10: a data source is greyed out only when its table is
 * `changed`/`missing`/`ambiguous`; here the table is recoverable by header).
 *
 * Self-contained: own Chrome launch (env-gated `--no-sandbox` + headless), own
 * fixture, `freshWorker` (robust to MV3 SW stops), correct `openSkillsPanel`.
 *
 * Run:
 *   node tests/e2e/multi-table-source-fallback.mjs
 *   E2E_HEADLESS=1 E2E_NO_SANDBOX=1 node tests/e2e/multi-table-source-fallback.mjs
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

// --- fixture: two art-tables; the skill's selector points at the wrong one --
const skillSourceMultiFixture = `<!doctype html><meta charset="utf-8"><title>Skill Source Multi Table</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:16px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #d1d5db;padding:8px 10px;text-align:left}
  </style>
  <div class="grid">
    <div class="art-table" id="wrong-table">
      <table>
        <thead><tr><th>序号</th><th>店铺链接</th><th>成交转化 更多指标</th></tr></thead>
        <tbody><tr><td>1</td><td>链接A</td><td>12</td></tr></tbody>
      </table>
    </div>
    <div class="art-table" id="target-table">
      <table>
        <thead><tr><th>序号</th><th>计划预算及消耗</th><th>计划转化 更多指标</th></tr></thead>
        <tbody><tr><td>1</td><td>100</td><td>9</td></tr></tbody>
      </table>
    </div>
  </div>`;

// --- stage an unpacked extension copy in a temp dir ------------------------
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web2ai-mt-"));
const extension = path.join(temp, "extension");
await fs.mkdir(extension);
await fs.cp(path.join(ROOT, "src"), path.join(extension, "src"), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = ["<all_urls>"];
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

// --- local server ----------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/skill-source-multi" ? skillSourceMultiFixture : "<h1>noop</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const multiTablePage = `${url}skill-source-multi`;

// --- a locator (v2) derived-column skill whose selector drifted ------------
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  protocolTimeout: 600000,
  pipe: true,
  enableExtensions: [extension],
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
// Re-resolve the current service-worker target before every call so a stopped
// MV3 worker (after idle) cannot leave worker.evaluate hanging on a stale handle.
const freshWorker = async () => {
  const target = await browser.waitForTarget(isExtensionServiceWorker, { timeout: 15000 }).catch(() => null);
  const handle = target ? await target.worker().catch(() => null) : null;
  if (!handle) throw new Error("extension service worker is not available");
  return handle;
};
const setStoredSkills = async (skills) => {
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
  log("storing drifted-selector skill");
  await setStoredSkills([
    makeLocatorDerivedSkill({
      id: "multi-table-derv",
      name: "多表定位恢复",
      pageUrl: multiTablePage,
      selector: "#wrong-table",
      headers: ["序号", "计划预算及消耗", "计划转化 更多指标"],
      selectedColumns: ["计划预算及消耗", "计划转化 更多指标"]
    })
  ]);

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[test][pageerror] ${e.message}`));
  log("opening multi-table page");
  await page.goto(multiTablePage);
  await page.waitForSelector("#web2ai_overlay_host");
  await openSkillsPanel(page);

  log("selector #wrong-table drifted; expect header-fingerprint fallback to target table → available");
  await waitForSkillStatusClass(page, "多表定位恢复", "available");
  {
    const statuses = await readSkillStatuses(page);
    const target = statuses.find((s) => s.name === "多表定位恢复");
    assert.ok(
      target && target.statusClass.includes("available"),
      `multi-table fallback must recover the exact-header table (status available) even though the selector drifted to another table: ${JSON.stringify(statuses)}`
    );
  }

  console.log("[test] multi-table source fallback passed");
  console.log("PASS multi-table-source-fallback");
} catch (error) {
  console.error(`[test] FAILED: ${error?.message ?? error}`);
  console.log("FAIL multi-table-source-fallback");
  process.exitCode = 1;
} finally {
  clearTimeout(HARD_TIMEOUT);
  try { await browser.close(); } catch {}
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  process.exit(process.exitCode || 0);
}
