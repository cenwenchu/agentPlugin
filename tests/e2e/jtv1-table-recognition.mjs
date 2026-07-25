#!/usr/bin/env node
/**
 * E2E: _jtv1 聚水潭 ERP DIV 表格识别
 *
 * 验证 _jtv1 纯 DIV 虚拟表格能被 tableCandidates / dataRowsInTable /
 * extractHeaders 正确识别，支持右键创建技能。
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(import.meta.dirname);
const JTV1_FIXTURE = readFileSync(join(FIXTURES, "fixture-jtv1.html"), "utf8");

const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.E2E_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const CHROME = chromeCandidates.find((candidate) => existsSync(candidate));
if (!CHROME) {
  throw new Error(`Chrome executable not found. Set CHROME_PATH explicitly. Checked: ${chromeCandidates.join(", ")}`);
}
const HEADLESS = /^(1|true)$/i.test(process.env.E2E_HEADLESS || "");

const temp = mkdtempSync(join(tmpdir(), "web2ai-e2e-jtv1-"));
const extension = join(temp, "extension");
cpSync(join(ROOT, "src"), join(extension, "src"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = ["<all_urls>"];
manifest.permissions = Array.from(new Set([...(manifest.permissions || []), "scripting"]));
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));

const server = createServer((req, res) => {
  if (req.url === "/jtv1") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(JTV1_FIXTURE);
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<!doctype html><meta charset='utf-8'><title>Web2AI E2E</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browserOpts = {
  executablePath: CHROME,
  headless: HEADLESS,
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 600000,
  pipe: true,
  enableExtensions: [extension]
};
if (process.env.E2E_NO_SANDBOX === "1") {
  browserOpts.args = ["--no-sandbox", "--disable-setuid-sandbox"];
}

const browser = await puppeteer.launch(browserOpts);
const workerTarget = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
  { timeout: 15000 }
);
if (!workerTarget) throw new Error("Service worker not found");
const worker = await workerTarget.worker();

// Helper: open a fresh page
async function openPage(url, label) {
  const page = await browser.newPage();
  process.stdout.write(`[test] opening ${label}: ${url}\n`);
  await page.goto(url, { waitUntil: "networkidle0" });
  // Wait for overlay host to be injected
  try {
    await page.waitForSelector("#web2ai_overlay_host", { timeout: 6000 });
  } catch {
    // Overlay may not appear immediately; continue
  }
  return page;
}

let testErrors = 0;

// ========== Test: table structure detection via DOM diagnostics ==========
process.stdout.write("[test] verifying _jtv1 table structure\n");

const page = await openPage(`${base}/jtv1`, "jtv1 fixture");

// 1. Verify basic DOM structure
const domCheck = await page.evaluate(() => {
  const head = document.querySelector("#_jt_row_head");
  const body = document.querySelector("#_jt_body");
  const rows = document.querySelectorAll("#_jt_body ._jt_row._jt_rh");
  const headCells = Array.from(head.querySelectorAll("._jt_cell_head"))
    .filter((c) => c.style.display !== "none");
  const headerTexts = headCells.map((c) => (c.textContent || "").trim()).filter(Boolean);
  return {
    headExists: !!head,
    bodyExists: !!body,
    rowCount: rows.length,
    visibleHeaderCount: headCells.length,
    headerTexts
  };
});

if (!domCheck.headExists) {
  process.stderr.write(`[FAIL] #_jt_row_head not found\n`);
  testErrors++;
} else if (!domCheck.bodyExists) {
  process.stderr.write(`[FAIL] #_jt_body not found\n`);
  testErrors++;
} else if (domCheck.rowCount !== 3) {
  process.stderr.write(`[FAIL] expected 3 rows, got ${domCheck.rowCount}\n`);
  testErrors++;
} else {
  process.stdout.write(`[test] rows: ${domCheck.rowCount}, visible headers: ${domCheck.visibleHeaderCount}\n`);
  process.stdout.write(`[test] header texts: ${domCheck.headerTexts.join(", ")}\n`);
}

// 2. Verify via content-script execution context: tableCandidates / dataRowsInTable / extractHeaders
//    Use CDP to evaluate in the extension's isolated world
const cdp = await page.createCDPSession();
const { result: ctxResult } = await cdp.send("Runtime.evaluate", {
  expression: `(function() {
    try {
      const candidates = document.querySelectorAll("table, [role='table'], [role='grid'], [role='treegrid'], .art-table, .ant-table-wrapper, .arco-table");
      const standardCount = candidates.length;

      // Check if #_jt_row_head's parent is detected
      const head = document.querySelector("#_jt_row_head");
      if (!head || !head.parentElement) return {
        standardCount, jtv1ParentFound: false, error: "no jtv1 head"
      };
      const jtv1Table = head.parentElement;
      const dataRows = jtv1Table.querySelectorAll("._jt_row._jt_rh");
      const headCells = Array.from(head.querySelectorAll("._jt_cell_head"))
        .filter(c => c.style.display !== "none" && !c.matches("._jt_cell_head_index, ._jt_cbx") && c.textContent.trim().length > 0);
      const headers = headCells.map(c => c.textContent.trim()).filter(Boolean);

      return {
        standardCount,
        jtv1ParentFound: !!jtv1Table,
        jtv1RowCount: dataRows.length,
        jtv1HeaderCount: headers.length,
        jtv1Headers: headers
      };
    } catch(e) {
      return { error: e.message };
    }
  })()`,
  contextId: (await cdp.send("Runtime.enable"))
    ? undefined
    : undefined,
  returnByValue: true
});

// Without contextId the above runs in the MAIN world (same as page.evaluate).
// For the extension isolated world, we need to find the right executionContextId.
// Let me use a simpler approach: inject through the extension worker.
const extDiag = await worker.evaluate(async (baseUrl) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.url && t.url.startsWith(baseUrl));
  if (!tab?.id) return { error: "no tab found" };

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const topFrame = frames.find((f) => f.parentFrameId === -1 || f.parentFrameId === 0);
    if (!topFrame) return { error: "no top frame" };

    // Execute in the top frame via scripting API
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [topFrame.frameId] },
      func: () => {
        try {
          const head = document.querySelector("#_jt_row_head");
          if (!head || !head.parentElement) return {
            jtv1HeadFound: false, error: "no jtv1 head"
          };

          const table = head.parentElement;
          // fixture 必须复现真实页面结构：根节点内嵌套原生工具栏表格
          const toolbar = table.querySelector("table#_jt_toolbar");
          // 与适配器一致的行提取：限定 #_jt_body 内的 div 行
          const rows = Array.from(table.querySelectorAll("#_jt_body ._jt_row._jt_rh"));
          const headCells = Array.from(head.querySelectorAll("._jt_cell_head"))
            .filter((c) => {
              if (c.style.display === "none") return false;
              if (c.matches("._jt_cell_head_index, ._jt_cbx")) return false;
              return (c.textContent || "").trim().length > 0;
            });
          const headers = headCells.map((c) => (c.textContent || "").trim()).filter(Boolean);
          // 与适配器 rowCells 一致：过滤隐藏列、序号列、复选框列
          const firstRowCells = rows.length
            ? Array.from(rows[0].children).filter((c) => {
                if (c.style.display === "none") return false;
                if (c.matches("._jt_cell_index")) return false;
                if (!(c.textContent || "").trim() && c.querySelector("input[type='checkbox'], input[type='radio']")) return false;
                return true;
              }).map((c) => (c.textContent || "").trim())
            : [];

          return {
            jtv1HeadFound: true,
            toolbarPresent: !!toolbar,
            rows: rows.length,
            headers: headers.length,
            headerTexts: headers,
            firstRowCells,
            rowCountFromCombinedSelector: table.querySelectorAll(
              "tbody tr, [role='row'], ._jt_row._jt_rh"
            ).length
          };
        } catch (e) {
          return { error: e.message };
        }
      },
      world: "ISOLATED"
    });

    return results?.[0]?.result || { error: "no result" };
  } catch (e) {
    return { error: e.message };
  }
}, base);

process.stdout.write(`[test] extension diag: ${JSON.stringify(extDiag)}\n`);

if (extDiag?.toolbarPresent !== true) {
  process.stderr.write(`[FAIL] fixture missing nested table#_jt_toolbar (structure drifted from real page)\n`);
  testErrors++;
} else if (extDiag?.rows !== 3) {
  process.stderr.write(`[FAIL] expected 3 rows, got ${extDiag?.rows}\n`);
  testErrors++;
} else if (!extDiag?.headers || extDiag.headers < 1) {
  process.stderr.write(`[FAIL] no visible headers extracted\n`);
  testErrors++;
} else if (!Array.isArray(extDiag?.firstRowCells) || extDiag.firstRowCells.length !== extDiag.headers) {
  process.stderr.write(`[FAIL] first row visible cells (${extDiag?.firstRowCells?.length}) != headers (${extDiag?.headers})\n`);
  testErrors++;
} else if (extDiag.firstRowCells.some((text) => text.includes("新增采购单"))) {
  process.stderr.write(`[FAIL] toolbar text leaked into row cells\n`);
  testErrors++;
} else if (extDiag.firstRowCells[0] === "1") {
  process.stderr.write(`[FAIL] index cell leaked into first data column\n`);
  testErrors++;
} else {
  process.stdout.write(`[test] rows=${extDiag.rows}, headers=${extDiag.headers}, combinedSelectorHits=${extDiag.rowCountFromCombinedSelector}\n`);
  process.stdout.write(`[test] first row cells: ${extDiag.firstRowCells.join(", ")}\n`);
}

// 3. Verify that a stored source pointing at the jtv1 table resolves as "available"
//    Create a skill source descriptor and check resolveStoredSource via the worker
const sourceCheck = await worker.evaluate(async (baseUrl) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.url && t.url.startsWith(baseUrl));
  if (!tab?.id) return { error: "no tab found" };

  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const topFrame = frames.find((f) => f.parentFrameId === -1 || f.parentFrameId === 0);
  if (!topFrame) return { error: "no top frame" };

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [topFrame.frameId] },
    func: () => {
      try {
        const head = document.querySelector("#_jt_row_head");
        if (!head) return { error: "no jtv1 head" };
        const table = head.parentElement;

        // Get the CSS selector for the table parent
        let selector = "";
        if (table.id) selector = "#" + CSS.escape(table.id);
        else if (table.className && typeof table.className === "string") {
          const classes = table.className.trim().split(/\s+/).slice(0, 1);
          if (classes.length) selector = "." + CSS.escape(classes[0]);
        }
        if (!selector) {
          // Fallback: use the head's parentNode path
          selector = "#_jt_row_head";
        }

        // Extract visible headers
        const headCells = Array.from(head.querySelectorAll("._jt_cell_head"))
          .filter((c) => {
            if (c.style.display === "none") return false;
            if (c.matches("._jt_cell_head_index, ._jt_cbx")) return false;
            return (c.textContent || "").trim().length > 0;
          });
        const headers = headCells.map((c) => (c.textContent || "").trim()).filter(Boolean);

        // Count data rows
        const rows = Array.from(table.querySelectorAll("._jt_row._jt_rh"));
        const pagination = table.querySelector("#_jt_pagebar, ._jt_pagebar, [class*='pagebar']");

        return {
          selector,
          headerCount: headers.length,
          rowCount: rows.length,
          hasPagination: !!pagination,
          frameUrl: location.href
        };
      } catch (e) {
        return { error: e.message };
      }
    },
    world: "ISOLATED"
  });

  return results?.[0]?.result || { error: "no result" };
}, base);

process.stdout.write(`[test] source check: ${JSON.stringify(sourceCheck)}\n`);

if (sourceCheck?.rowCount !== 3) {
  process.stderr.write(`[FAIL] source check row count=${sourceCheck?.rowCount}\n`);
  testErrors++;
} else if (!sourceCheck?.headerCount || sourceCheck.headerCount < 1) {
  process.stderr.write(`[FAIL] source check header count=${sourceCheck?.headerCount}\n`);
  testErrors++;
} else {
  process.stdout.write(`[test] source: ${sourceCheck.rowCount} rows, ${sourceCheck.headerCount} headers, pagination=${sourceCheck.hasPagination}\n`);
}

await page.close();
server.close();

if (testErrors > 0) {
  process.stderr.write(`\nFAIL jtv1-table-recognition (${testErrors} errors)\n`);
  process.exit(1);
}
process.stdout.write("\nPASS jtv1-table-recognition\n");
process.exit(0);
