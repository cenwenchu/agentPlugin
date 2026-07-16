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
// Keep the production host permission because captureVisibleTab requires
// activeTab or <all_urls>; narrowing it would test a different permission model.
manifest.host_permissions = ["<all_urls>"];
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
  "#web2ai_table_row_ask_ai",
  (button) => button.click()
);
const reenterRow = async (page, row) => {
  // A virtual list can rewrite a row while the pointer remains stationary.
  // Let the extension reconcile the recycled DOM node on the virtual-list
  // scroll frame, then re-enter through a cell not covered by the pinned check.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
  });
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
  await new Promise((resolve) => setTimeout(resolve, 220));
  const hasAskAction = await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display !== "none");
  if (!hasAskAction) {
    const detail = await cell.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        row: node.closest("tr,[role='row']")?.outerHTML,
        stack: stack.map((item) => `${item.tagName}#${item.id}.${item.className}`).slice(0, 8)
      };
    });
    throw new Error(`Dynamic row hover did not expose its Ask AI action: ${JSON.stringify(detail)}`);
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
    (target) => target.type() === "service_worker" && /^chrome-extension:\/\/[^/]+\/src\/background\.js$/.test(target.url()),
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

  // Closing the launcher is the global opt-out for page UI, including table
  // selection. Restoring it mirrors clicking the browser toolbar action.
  await page.$eval("#web2ai_launcher_fab [data-web2ai-close-launcher]", (button) => button.click());
  await page.waitForFunction(() => document.querySelector("#web2ai_launcher_fab")?.style.display === "none");
  const closeNotice = await page.$eval("#web2ai_toast", (node) => node.textContent || "");
  assert.match(closeNotice, /点击浏览器工具栏中的插件扩展图标/, "closing launcher must explain how to restore chat");
  const disabledRow = await page.$("#orders tbody tr");
  await disabledRow.hover();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const askHidden = await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display === "none");
  assert.equal(askHidden, true, "hidden launcher must disable table selection UI");

  const worker = await extensionTarget.worker();
  assert.ok(worker, "extension service worker must be available to restore the launcher");
  await worker.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    if (!tab?.id) throw new Error("fixture tab not found");
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_LAUNCHER" }, { frameId: 0 });
  }, url);
  await page.waitForFunction(() => document.querySelector("#web2ai_launcher_fab")?.style.display === "flex");

  // Moving away from Chat keeps it open; an explicit page click closes it.
  await page.$eval("#web2ai_overlay_host", (host) => {
    if (host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")) {
      document.querySelector("#web2ai_launcher_fab")?.click();
    }
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));
  await page.hover("#page-click-target");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stayedOpenAfterHover = await page.$eval("#web2ai_overlay_host", (host) => !host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden"));
  assert.equal(stayedOpenAfterHover, true, "moving the pointer outside Chat must keep it open");
  await page.click("#page-click-target");
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));

  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.sync.get(["settings"]);
    const models = [...settings.models, {
      id: "vision-e2e",
      name: "Vision E2E",
      baseUrl: "https://example.invalid",
      model: "vision-test",
      supportsImages: true,
      contextWindow: 32000,
      maxOutputTokens: 2048
    }];
    await chrome.storage.sync.set({ settings: { ...settings, models } });
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll("#web2ai_model_select option").length === 2);
  await page.$eval("#web2ai_overlay_host", (host) => {
    const select = host.shadowRoot.querySelector("#web2ai_model_select");
    select.value = "vision-e2e";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await worker.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const { settings } = await chrome.storage.sync.get(["settings"]);
      if (settings.activeModelId === "vision-e2e") return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Chat model switch did not persist");
  });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
    const select = shadow?.querySelector("#web2ai_model_select");
    const tip = Array.from(shadow?.querySelectorAll(".header span") || []).find((node) => node.textContent === "支持图片");
    return select?.selectedOptions?.[0]?.textContent === "Vision E2E" && Boolean(tip);
  });

  await page.click("#web2ai_launcher_fab");
  await page.$eval("#web2ai_overlay_host", (host) => {
    const button = Array.from(host.shadowRoot.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === "截图");
    button.click();
  });
  await page.waitForSelector("#web2ai_screenshot_selector");
  await page.mouse.move(40, 40);
  await page.mouse.down();
  await page.mouse.move(220, 160, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".contextScreenshot").length === 1);
  const croppedPreview = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".contextScreenshot")?.src || "");
  assert.match(croppedPreview, /^data:image\/jpeg;base64,/, "the screenshot action must add a cropped JPEG context");
  await page.$eval("#web2ai_overlay_host", (host) => {
    const send = Array.from(host.shadowRoot.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "问一下");
    send.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_toast")?.textContent?.includes("填写希望大模型对图片做什么分析"), { timeout: 10000 });
  const imagePromptNotice = await page.$eval("#web2ai_toast", (node) => node.textContent || "");
  assert.match(imagePromptNotice, /填写希望大模型对图片做什么分析/, "an image-only empty first request must ask the user for an analysis instruction");

  // The left-side Monitor tab can create a local text-change sentinel. It
  // remains active while this tab is open, even when the panel is not focused.
  await page.$eval("#web2ai_overlay_host", (host) => {
    const monitorTab = Array.from(host.shadowRoot.querySelectorAll(".sideTab"))
      .find((button) => button.textContent?.trim() === "监控");
    monitorTab.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".sideTab.active")?.textContent?.trim() === "监控");
  await page.$eval("#web2ai_overlay_host", (host) => {
    const create = Array.from(host.shadowRoot.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("创建监控"));
    create.click();
  });
  await page.waitForFunction(() => Boolean(document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".monitorForm")));
  await page.$eval("#web2ai_overlay_host", (host) => {
    const selectTarget = Array.from(host.shadowRoot.querySelectorAll(".monitorForm button"))
      .find((button) => button.textContent?.includes("选择元素"));
    selectTarget.click();
  });
  await page.hover("#replace");
  await page.waitForSelector("[data-web2ai-monitor-confirm='1']");
  await page.click("#replace");
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".monitorTarget")?.textContent?.includes("替换分页数据"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    const shadow = host.shadowRoot;
    const name = shadow.querySelector(".monitorForm .monitorInput");
    name.value = "E2E 页面状态";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const save = Array.from(shadow.querySelectorAll(".monitorForm button"))
      .find((button) => button.textContent?.trim() === "创建监控");
    save.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".monitorCard")?.textContent?.includes("E2E 页面状态"));
  await page.$eval("#replace", (button) => { button.textContent = "发现待处理订单"; });
  await worker.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      const data = await chrome.storage.local.get(["web2aiMonitors"]);
      const rule = (data.web2aiMonitors || []).find((item) => item.name === "E2E 页面状态");
      if (rule?.triggerCount === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("text-change monitor did not trigger");
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    const remove = host.shadowRoot.querySelector(".monitorCard .btn.danger");
    remove.click();
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".monitorCard"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    const chatTab = Array.from(host.shadowRoot.querySelectorAll(".sideTab"))
      .find((button) => button.textContent?.trim() === "Chat");
    chatTab.click();
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    host.shadowRoot.querySelector(".contextScreenshot")?.closest(".contextItem")?.querySelector(".ctxRemove")?.click();
    const close = Array.from(host.shadowRoot.querySelectorAll(".header button"))
      .find((button) => button.textContent?.trim() === "×");
    close.click();
  });

  const firstRow = await page.$("#orders tbody tr");
  await firstRow.hover();
  await page.waitForSelector("#web2ai_table_row_ask_ai", { visible: true });
  await clickInlineCheckbox(page);
  await page.waitForSelector("#web2ai_batch_bar", { visible: true });
  assert.equal(await page.$eval("#order-1 td:first-child", (cell) => Boolean(cell.querySelector("[data-web2ai-pinned-action]"))), true, "selected check marker must appear in the first column");
  // Live dashboards may refresh cell values while the pointer remains on a selected row.
  // Hover must not mistake that refresh for virtual-row recycling.
  await page.$eval("#order-1 td:last-child", (cell) => { cell.textContent = "101"; });
  await firstRow.hover();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await page.$eval("#order-1", (row) => row.dataset.web2aiSelected), "1", "live value refresh during hover must preserve row selection");
  assert.equal(await page.$eval("#order-1 td:first-child", (cell) => Boolean(cell.querySelector("[data-web2ai-pinned-action]"))), true, "live value refresh during hover must preserve the check marker");
  assert.equal(await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display === "none"), true, "Ask AI must stay hidden for an already selected row");
  await page.$eval("#order-1 td:last-child", (cell) => { cell.textContent = "100"; });
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

  // A selected-row marker must not sit above a site's body-level menu. The
  // marker remains clickable itself, but its wrapper uses only local stacking.
  await page.evaluate(() => {
    const marker = document.querySelector("#order-1 [data-web2ai-pinned-action]");
    const rect = marker.getBoundingClientRect();
    const menu = document.createElement("button");
    menu.id = "fixture-menu-over-marker";
    menu.textContent = "menu action";
    Object.assign(menu.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: "10"
    });
    menu.addEventListener("click", () => { menu.dataset.clicked = "1"; });
    document.documentElement.appendChild(menu);
  });
  await page.click("#fixture-menu-over-marker");
  const menuResult = await page.$eval("#fixture-menu-over-marker", (menu) => {
    const rect = menu.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const marker = document.querySelector("#order-1 [data-web2ai-pinned-action]");
    return {
      clicked: menu.dataset.clicked || "",
      top: `${top?.tagName || ""}#${top?.id || ""}`,
      markerZ: marker?.parentElement?.style.zIndex || ""
    };
  });
  assert.equal(menuResult.clicked, "1", `site menu above a selected row must remain clickable: ${JSON.stringify(menuResult)}`);
  await page.$eval("#fixture-menu-over-marker", (menu) => menu.remove());

  const secondDataRow = await page.$("#order-2");
  await secondDataRow.hover();
  await page.waitForSelector("#web2ai_table_row_ask_ai", { visible: true });
  await clickInlineCheckbox(page);
  const afterTwoSingles = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(afterTwoSingles, /2 条/, "two consecutive single selections must both remain selected");
  const secondRowStillSelected = await page.$eval("#order-2", (row) => row.dataset.web2aiSelected);
  assert.equal(secondRowStillSelected, "1", "the second single selection must retain its UI state");

  await page.$eval("#web2ai_overlay_host", (host) => {
    if (host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")) {
      document.querySelector("#web2ai_launcher_fab")?.click();
    }
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));
  await page.click("#web2ai_batch_select_all");
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => !host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")),
    true,
    "select all on the current page must not close Chat"
  );
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
  const noKeyRecycledAskVisible = await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display !== "none");
  assert.equal(noKeyRecycledAskVisible, true, "leading-column fingerprint must detect a recycled row without rowKey");
  await clickInlineCheckbox(page);
  const noKeyReusedLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(noKeyReusedLabel, /4 条/, "the recycled keyless row must be added as a new snapshot");

  await page.click("#reuse");
  const reusedRow = await page.$("#order-reused");
  await reenterRow(page, reusedRow);
  const recycledAskVisible = await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display !== "none");
  assert.equal(recycledAskVisible, true, "a recycled DOM row must not inherit the old selection UI");
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
  await frame.waitForSelector("#web2ai_table_row_ask_ai", { visible: true });
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

  // Pagination widgets may detach an old page and cache its DOM. A global
  // clear must invalidate that detached row as well, so it cannot look selected
  // when the page is mounted again.
  await reenterRow(page, replacementRow);
  await clickInlineCheckbox(page);
  await page.evaluate(() => {
    const row = document.querySelector("#order-3");
    window.__web2aiCachedPageRow = row;
    row.remove();
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    const clear = Array.from(host.shadowRoot.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "清空全部");
    clear.click();
  });
  await page.evaluate(() => {
    document.querySelector("#body").appendChild(window.__web2aiCachedPageRow);
    delete window.__web2aiCachedPageRow;
  });
  const remountedRow = await page.$("#order-3");
  await reenterRow(page, remountedRow);
  const remountedState = await page.$eval("#order-3", (row) => ({
    selected: row.dataset.web2aiSelected || "",
    hasPinnedCheck: Boolean(row.querySelector("[data-web2ai-pinned-action]"))
  }));
  assert.deepEqual(remountedState, { selected: "", hasPinnedCheck: false }, "remounted cached pages must stay cleared after one global clear");

  await page.reload();
  await page.waitForSelector("#web2ai_overlay_host");
  const contextCount = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".contextItem").length);
  assert.equal(contextCount, 0, "refresh must clear in-memory contexts");
  console.log("Chrome E2E passed: model switching, screenshots, page monitoring, launcher toggle, table gating, iframe injection, virtual rows, refresh clearing");
} finally {
  await browser.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
