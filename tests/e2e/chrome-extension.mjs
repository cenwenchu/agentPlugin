import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web2ai-e2e-"));
const extension = path.join(temp, "extension");
await fs.mkdir(extension);
await fs.cp(path.join(ROOT, "src"), path.join(extension, "src"), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
manifest.content_scripts = [{ matches: ["http://127.0.0.1/*"], js: ["src/content/loader.js"], all_frames: true, match_about_blank: true, run_at: "document_idle" }];
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

const fixture = await fs.readFile(path.join(ROOT, "tests/e2e/fixture.html"));
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(fixture); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });

try {
  const page = await browser.newPage();
  const browserDiagnostics = [];
  page.on("console", (message) => browserDiagnostics.push(`[console:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => browserDiagnostics.push(`[pageerror] ${error.message}`));
  await page.goto(url);
  try {
    await page.waitForSelector("#web2ai_overlay_host");
  } catch (error) {
    const detail = browserDiagnostics.length ? `\n${browserDiagnostics.join("\n")}` : "\nNo page diagnostics were emitted.";
    throw new Error(`Extension entry did not initialize.${detail}`, { cause: error });
  }

  const firstRow = await page.$("#orders tbody tr");
  await firstRow.hover();
  await page.waitForSelector("#web2ai_table_row_inline_checkbox");
  await page.click("#web2ai_table_row_inline_checkbox");
  await page.waitForSelector("#web2ai_batch_bar", { visible: true });
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const headerStillSelected = await page.$eval("#orders thead tr", (row) => row.dataset.web2aiSelected);
  const firstRowStillSelected = await page.$eval("#order-1", (row) => row.dataset.web2aiSelected);
  assert.equal(headerStillSelected, "1", "plugin check UI must not change a header's rendered identity");
  assert.equal(firstRowStillSelected, "1", "selected data row must retain its check rendering");
  const secondaryRowSelected = await page.$eval("#secondary-order-1", (row) => row.dataset.web2aiSelected || "");
  const footerRowSelected = await page.$eval("#orders-total", (row) => row.dataset.web2aiSelected || "");
  assert.equal(secondaryRowSelected, "", "two identical table components must not share selection state");
  assert.equal(footerRowSelected, "", "a fixed summary row must never inherit the first data row selection");

  const secondDataRow = await page.$("#order-2");
  await secondDataRow.hover();
  await page.click("#web2ai_table_row_inline_checkbox");
  const afterTwoSingles = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(afterTwoSingles, /2 条/, "two consecutive single selections must both remain selected");
  const secondRowStillSelected = await page.$eval("#order-2", (row) => row.dataset.web2aiSelected);
  assert.equal(secondRowStillSelected, "1", "the second single selection must retain its UI state");

  await page.click("#web2ai_batch_select_all");
  const afterBatchLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(afterBatchLabel, /3 条/, "select-all after selecting rows 1 and 2 must only add row 3");
  const noKeyRow = await page.$("#no-key-row");
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const noKeyStillSelected = await page.$eval("#no-key-row", (row) => row.dataset.web2aiSelected);
  assert.equal(noKeyStillSelected, "1", "a row without a business key must retain its batch selection");
  const groupLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(groupLabel, /表格 1/);

  await page.click("#reuse-no-key");
  await noKeyRow.hover();
  const noKeyRecycledChecked = await page.$eval("#web2ai_table_row_inline_checkbox", (input) => input.checked);
  assert.equal(noKeyRecycledChecked, false, "leading-column fingerprint must detect a recycled row without rowKey");
  await page.click("#web2ai_table_row_inline_checkbox");

  await page.click("#reuse");
  const reusedRow = await page.$("#order-reused");
  await reusedRow.hover();
  const recycledChecked = await page.$eval("#web2ai_table_row_inline_checkbox", (input) => input.checked);
  assert.equal(recycledChecked, false, "a recycled DOM row must not inherit the old selection UI");
  await page.click("#web2ai_table_row_inline_checkbox");
  const reusedLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(reusedLabel, /5 条/, "the old snapshots and reused rows must all remain selected");

  const frame = page.frames().find((item) => item !== page.mainFrame());
  await frame.waitForSelector("#web2ai_overlay_host");

  await page.click("#replace");
  await page.waitForSelector("#order-3");
  const replacementRow = await page.$("#order-3");
  await replacementRow.hover();
  await page.waitForSelector("#web2ai_table_row_inline_checkbox");
  await page.click("#web2ai_table_row_inline_checkbox");
  const replacementLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(replacementLabel, /6 条/);
  const cumulativeBatchCount = await page.$eval("#web2ai_batch_count", (node) => node.textContent || "");
  assert.match(cumulativeBatchCount, /已加入 6 行/, "virtualized snapshots must remain in the batch count after DOM replacement");
  await page.click("#web2ai_batch_clear_all");
  await page.waitForFunction(() => {
    const host = document.querySelector("#web2ai_overlay_host");
    return !host?.shadowRoot?.querySelector(".tableGroupLabel");
  });

  await page.reload();
  await page.waitForSelector("#web2ai_overlay_host");
  const contextCount = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".contextItem").length);
  assert.equal(contextCount, 0, "refresh must clear in-memory contexts");
  console.log("Chrome E2E passed: fixed header, iframe injection, virtual row reuse, DOM replacement, refresh clearing");
} finally {
  await browser.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
