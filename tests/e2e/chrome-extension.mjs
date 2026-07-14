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
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

const fixture = await fs.readFile(path.join(ROOT, "tests/e2e/fixture.html"));
const frameFixture = "<table><tbody><tr data-row-key='frame-1'><td>iframe row</td></tr></tbody></table>";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url === "/frame" ? frameFixture : fixture);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const clickInlineCheckbox = (page) => page.$eval(
  "#web2ai_table_row_inline_checkbox",
  (checkbox) => checkbox.click()
);
const reenterRow = async (page, row) => {
  // A virtual list can rewrite a row while the pointer remains stationary.
  // Let the extension reconcile the recycled DOM node on the virtual-list
  // scroll frame, then re-enter through a cell not covered by the pinned check.
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cell = await row.$("td:nth-child(3), [role='cell']:nth-child(3)");
  assert.ok(cell, "dynamic row must expose a business cell for pointer interaction");
  await cell.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const hasCheckbox = await page.$("#web2ai_table_row_inline_checkbox");
  if (!hasCheckbox) {
    const detail = await cell.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        row: node.closest("tr,[role='row']")?.outerHTML,
        stack: stack.map((item) => `${item.tagName}#${item.id}.${item.className}`).slice(0, 8)
      };
    });
    throw new Error(`Dynamic row hover did not expose its checkbox: ${JSON.stringify(detail)}`);
  }
};
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  // Puppeteer's path-based extension loader communicates over the DevTools pipe.
  // Without this option Chrome starts, but Puppeteer rejects the launch before
  // the extension can be installed, so none of the browser regressions run.
  pipe: true,
  enableExtensions: [extension]
});

try {
  const extensionTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
    { timeout: 15000 }
  );
  assert.match(extensionTarget.url(), /^chrome-extension:\/\//, "extension service worker must start before page tests");
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
  await clickInlineCheckbox(page);
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
  await clickInlineCheckbox(page);
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
  await reenterRow(page, noKeyRow);
  const noKeyRecycledChecked = await page.$eval("#web2ai_table_row_inline_checkbox", (input) => input.checked);
  assert.equal(noKeyRecycledChecked, false, "leading-column fingerprint must detect a recycled row without rowKey");
  await clickInlineCheckbox(page);
  const noKeyReusedLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(noKeyReusedLabel, /4 条/, "the recycled keyless row must be added as a new snapshot");

  await page.click("#reuse");
  const reusedRow = await page.$("#order-reused");
  await reenterRow(page, reusedRow);
  const recycledChecked = await page.$eval("#web2ai_table_row_inline_checkbox", (input) => input.checked);
  assert.equal(recycledChecked, false, "a recycled DOM row must not inherit the old selection UI");
  await clickInlineCheckbox(page);
  const reusedLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(reusedLabel, /5 条/, "the old snapshots and reused rows must all remain selected");

  const frame = page.frames().find((item) => item !== page.mainFrame());
  assert.ok(frame, "fixture iframe must be attached");
  const frameRow = await frame.waitForSelector("tr");
  await frameRow.$eval("td", (cell) => {
    const rect = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));
  });
  await frame.waitForSelector("#web2ai_table_row_inline_checkbox");
  const frameOverlayCount = await frame.$$("#web2ai_overlay_host");
  assert.equal(frameOverlayCount.length, 0, "child frames collect rows without creating a second main overlay");

  await page.click("#replace");
  await page.waitForSelector("#order-3");
  const replacementRow = await page.$("#order-3");
  await reenterRow(page, replacementRow);
  await clickInlineCheckbox(page);
  const replacementLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(replacementLabel, /6 条/);
  const cumulativeBatchCount = await page.$eval("#web2ai_batch_count", (node) => node.textContent || "");
  assert.match(cumulativeBatchCount, /已加入 6 行/, "virtualized snapshots must remain in the batch count after DOM replacement");
  await page.$eval("#web2ai_batch_clear_all", (button) => button.click());
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterCurrentPageClear = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.equal(afterCurrentPageClear, "", "clearing the current page must remove all snapshots with that page index");

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
