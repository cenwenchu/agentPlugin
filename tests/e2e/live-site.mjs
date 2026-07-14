import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = process.env.WEB2AI_LIVE_PROFILE || "/tmp/web2ai-live-profile";
const URL = "https://sc.scm121.com/printManage/supplierTrade/tradePrint";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  userDataDir: PROFILE,
  defaultViewport: null,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
});
const pages = await browser.pages();
const page = pages[0] || await browser.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => void 0);
console.log("LIVE_CHROME_READY 登录并打开订单表格后，在 Codex 中告诉我。");

const input = readline.createInterface({ input: process.stdin, output: process.stdout });
input.on("line", async (line) => {
  if (line.trim() !== "test") return;
  try {
    const deadline = Date.now() + 30000;
    let frame;
    while (Date.now() < deadline) {
      for (const candidate of page.frames()) {
        if (await candidate.$(".art-table-row").catch(() => null)) {
          frame = candidate;
          break;
        }
      }
      if (frame) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!frame) {
      throw new Error(`未找到订单表格；page=${page.url()} title=${await page.title()} frames=${JSON.stringify(page.frames().map((item) => item.url()))}`);
    }

    const rows = await frame.$$(".art-table-row");
    if (rows.length < 2) throw new Error(`当前只渲染了 ${rows.length} 行，无法执行 1、2 两行测试`);
    const injection = {
      pageUrl: page.url(),
      frameUrl: frame.url(),
      topHost: await page.$eval("body", (body) => body.querySelectorAll("#web2ai_overlay_host").length),
      frameHost: await frame.$eval("body", (body) => body.querySelectorAll("#web2ai_overlay_host").length),
      frameLauncher: await frame.$eval("body", (body) => body.querySelectorAll("#web2ai_launcher_fab").length),
      firstRow: await rows[0].evaluate((row) => ({
        className: row.className,
        tagName: row.tagName,
        parentClasses: Array.from({ length: 6 }, (_, index) => {
          let node = row;
          for (let i = 0; i <= index; i++) node = node?.parentElement;
          return node ? `${node.tagName}.${node.className}` : "";
        })
      }))
    };
    console.log("LIVE_INJECTION_DIAG " + JSON.stringify(injection));
    const before = await frame.$$eval(".art-table-row", (items) => items.slice(0, 8).map((row) => ({
      index: row.getAttribute("data-rowindex"),
      firstColumns: Array.from(row.querySelectorAll("td")).slice(0, 4).map((cell) => cell.innerText.trim())
    })));

    for (const row of rows.slice(0, 2)) {
      await row.hover();
      await frame.waitForSelector("#web2ai_table_row_inline_checkbox", { visible: true });
      const checkbox = await frame.$("#web2ai_table_row_inline_checkbox");
      if (!await checkbox.evaluate((input) => input.checked)) await checkbox.click();
    }

    const afterSingles = await frame.$$eval(".art-table-row", (items) => items.slice(0, 8).map((row) => row.dataset.web2aiSelected === "1"));
    await frame.click("#web2ai_batch_select_all");
    const afterBatch = await frame.$$eval(".art-table-row", (items) => items.slice(0, 8).map((row) => row.dataset.web2aiSelected === "1"));
    const batchCount = await frame.$eval("#web2ai_batch_count", (node) => node.textContent || "");
    const groupLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot?.querySelector(".tableGroupLabel")?.textContent || "");

    console.log("LIVE_TEST_RESULT " + JSON.stringify({ before, afterSingles, afterBatch, batchCount, groupLabel }));
  } catch (error) {
    console.error("LIVE_TEST_ERROR " + (error?.stack || error));
  }
});

process.on("SIGINT", async () => {
  input.close();
  await browser.close();
  process.exit(0);
});
