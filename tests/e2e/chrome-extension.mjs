import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};
const createZip = (files) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web2ai-e2e-"));
const extension = path.join(temp, "extension");
const runtimeCsv = path.join(temp, "runtime-orders.csv");
const runtimeXlsx = path.join(temp, "runtime-after-sales.xlsx");
await fs.mkdir(extension);
await fs.cp(path.join(ROOT, "src"), path.join(extension, "src"), { recursive: true });
await fs.writeFile(runtimeCsv, "渠道,订单数,备注\n线上,12,\n线下,8,人工订单\n", "utf8");
await fs.writeFile(runtimeXlsx, createZip({
  "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="售后明细" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
  "xl/worksheets/sheet1.xml": '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>售后单号</t></is></c><c r="B1" t="inlineStr"><is><t>状态</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>R-100</t></is></c><c r="B2" t="inlineStr"><is><t>待处理</t></is></c></row></sheetData></worksheet>'
}));
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
// Keep the production host permission because captureVisibleTab requires
// activeTab or <all_urls>; narrowing it would test a different permission model.
manifest.host_permissions = ["<all_urls>"];
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));

const fixture = await fs.readFile(path.join(ROOT, "tests/e2e/fixture.html"));
const frameFixture = "<table><tbody><tr data-row-key='frame-1'><td>iframe row</td></tr></tbody></table>";
const innerScrollFixture = `<!doctype html><meta charset="utf-8"><title>Inner scroll</title>
  <style>html,body{margin:0;height:100%;overflow:hidden}#scrollbox{height:420px;width:100%;overflow-y:auto;background:#fff}#long-content{height:2200px;background:linear-gradient(#dbeafe,#fef3c7,#dcfce7)}</style>
  <div id="scrollbox"><div id="long-content">内部滚动容器</div></div>`;
const innerFrameHostFixture = `<!doctype html><meta charset="utf-8"><title>Inner frame host</title>
  <style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style><iframe src="/inner-scroll"></iframe>`;
const virtualCollectionFixture = `<!doctype html><meta charset="utf-8"><title>Virtual collection</title>
  <style>#virtual-scroll{height:120px;overflow-y:auto;border:1px solid #ddd}.virtual-canvas{height:480px;position:relative}.art-table{position:absolute;left:0;right:0}.art-table-row,[role=columnheader]{height:40px;box-sizing:border-box}.pagination{margin-top:12px}</style>
  <div id="virtual-scroll"><div class="virtual-canvas"><div id="virtual-table" class="art-table">
    <div class="art-table-header-row" role="row"><div role="columnheader">序号</div><div role="columnheader">订单号</div></div>
    <div id="virtual-rows"></div>
  </div></div></div>
  <div class="ant-pagination pagination"><button class="ant-pagination-item ant-pagination-item-active">1</button><button class="ant-pagination-item">2</button><span class="ant-pagination-next"><button class="ant-pagination-item-link" aria-label="下一页">下一页</button></span></div>
  <script>
    let page = 1;
    const scroll = document.querySelector('#virtual-scroll');
    const table = document.querySelector('#virtual-table');
    const rows = document.querySelector('#virtual-rows');
    const pageButtons = [...document.querySelectorAll('.ant-pagination-item')];
    function render() {
      const start = Math.min(9, Math.floor(scroll.scrollTop / 40));
      table.style.transform = 'translateY(' + (start * 40) + 'px)';
      rows.innerHTML = Array.from({length:3}, (_, offset) => {
        const index = start + offset + 1;
        return '<div class="art-table-row" role="row" data-row-key="p' + page + '-' + index + '"><div role="cell">' + index + '</div><div role="cell">P' + page + '-ORDER-' + index + '</div></div>';
      }).join('');
      pageButtons.forEach((button, index) => button.classList.toggle('ant-pagination-item-active', index + 1 === page));
    }
    scroll.addEventListener('scroll', render);
    pageButtons.forEach((button, index) => button.addEventListener('click', () => { page = index + 1; scroll.scrollTop = 200; render(); }));
    document.querySelector('.ant-pagination-next button').addEventListener('click', () => { if (page < 2) { page++; scroll.scrollTop = 200; render(); } });
    scroll.scrollTop = 200;
    render();
  <\/script>`;
const derivedRuntimeFixture = `<!doctype html><meta charset="utf-8"><title>Derived runtime</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:16px}
    .art-table{margin-top:12px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #d1d5db;padding:8px 10px;text-align:left}
    th{background:#f8fafc}
    .toolbar,.pagination{display:flex;gap:8px;align-items:center;margin-top:12px}
    .derived-page-btn[data-active="1"]{background:#2563eb;color:#fff}
  </style>
  <div class="toolbar">
    <span>当前页：<strong id="derived-current-page">1</strong></span>
    <button id="derived-rerender">重绘当前页</button>
  </div>
  <div class="art-table" id="derived-orders">
    <table><thead><tr><th>订单号</th><th>金额</th><th>状态</th></tr></thead></table>
    <table><tbody id="derived-body"></tbody></table>
  </div>
  <div class="pagination">
    <button id="derived-page-1" class="derived-page-btn" data-page="1" data-active="1">1</button>
    <button id="derived-page-2" class="derived-page-btn" data-page="2" data-active="0">2</button>
  </div>
  <script>
    const pages = {
      1: [
        ["D-100", "100", "待处理"],
        ["D-101", "50", "正常"]
      ],
      2: [
        ["D-200", "999", "高风险"],
        ["D-201", "20", "正常"]
      ]
    };
    let currentPage = 1;
    function render() {
      const body = document.querySelector('#derived-body');
      body.innerHTML = (pages[currentPage] || []).map((row, index) => (
        '<tr data-row-key="page-' + currentPage + '-row-' + index + '">' +
          '<td>' + row[0] + '</td>' +
          '<td>' + row[1] + '</td>' +
          '<td>' + row[2] + '</td>' +
        '</tr>'
      )).join('');
      document.querySelector('#derived-current-page').textContent = String(currentPage);
      document.querySelectorAll('.derived-page-btn').forEach((button) => {
        button.dataset.active = button.dataset.page === String(currentPage) ? '1' : '0';
      });
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    }
    document.querySelector('#derived-page-1').onclick = () => { currentPage = 1; render(); };
    document.querySelector('#derived-page-2').onclick = () => { currentPage = 2; render(); };
    document.querySelector('#derived-rerender').onclick = () => render();
    render();
  <\/script>`;
function parseDerivedRowsFromMessages(messages = []) {
  const content = (Array.isArray(messages) ? messages : [])
    .map((message) => typeof message?.content === "string" ? message.content : "")
    .join("\n");
  const marker = "输入数据：\n";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  try {
    const payload = JSON.parse(content.slice(markerIndex + marker.length).trim());
    return Array.isArray(payload?.rows) ? payload.rows : null;
  } catch {
    return null;
  }
}

function buildDerivedRuntimeResponse(rows = []) {
  return JSON.stringify({
    results: rows.map((row, index) => ({
      fingerprint: row.fingerprint,
      conclusion: `E2E结论${index + 1}`
    }))
  });
}

let aiRequestCount = 0;
let derivedAiRequestCount = 0;
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    aiRequestCount++;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const derivedRows = parseDerivedRowsFromMessages(payload.messages);
      const content = derivedRows?.length
        ? (derivedAiRequestCount++, buildDerivedRuntimeResponse(derivedRows))
        : "E2E 分析完成";
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }
    });
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    req.url === "/frame" ? frameFixture
      : req.url === "/inner-scroll" ? innerScrollFixture
      : req.url === "/inner-frame-host" ? innerFrameHostFixture
      : req.url === "/virtual-collection" ? virtualCollectionFixture
      : req.url === "/derived-runtime" ? derivedRuntimeFixture
      : fixture
  );
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
const setDerivedRuntimeSkills = async (worker, { pageUrl, skills, pageRequestLimitPerMinute = 1 }) => {
  await worker.evaluate(async ({ pageUrl: targetPageUrl, skills: nextSkills, limit }) => {
    const SKILL_STORAGE_KEY = "web2aiSkills";
    const SKILL_PAGE_NAMES_STORAGE_KEY = "web2aiSkillPageNames";
    const { settings } = await chrome.storage.sync.get(["settings"]);
    const models = (settings?.models || []).map((profile) => ({
      ...profile,
      baseUrl: targetPageUrl.replace(/derived-runtime$/, ""),
      model: "e2e-local",
      pageRequestLimitPerMinute: limit
    }));
    const activeModelId = models[0]?.id || settings?.activeModelId || settings?.defaultModelId || "default";
    const { modelApiKeys = {} } = await chrome.storage.local.get(["modelApiKeys"]);
    const localKeys = Object.fromEntries(models.map((profile) => [profile.id, "e2e-key"]));
    await Promise.all([
      chrome.storage.sync.set({
        settings: {
          ...settings,
          models,
          activeModelId,
          defaultModelId: activeModelId
        }
      }),
      chrome.storage.local.set({
        [SKILL_STORAGE_KEY]: nextSkills,
        [SKILL_PAGE_NAMES_STORAGE_KEY]: {},
        modelApiKeys: { ...modelApiKeys, ...localKeys }
      }),
      chrome.storage.session?.clear?.()
    ]);
  }, {
    pageUrl,
    skills,
    limit: pageRequestLimitPerMinute
  });
};

const makeDerivedSkill = ({
  id,
  name,
  pageUrl,
  columnName,
  autoRunEnabled
}) => ({
  id,
  type: "derived-column",
  name,
  revision: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  analysisMethod: { description: "识别风险并给出简短判断" },
  sources: [{
    id: `${id}-source`,
    pageKey: pageUrl,
    frameUrl: pageUrl,
    selector: "#derived-orders",
    tableIndex: 0,
    headers: ["订单号", "金额", "状态"]
  }],
  selectedColumns: [
    { header: "金额", occurrence: 1 },
    { header: "状态", occurrence: 1 }
  ],
  output: {
    columnName,
    maxChars: 1000
  },
  trigger: {
    autoRunEnabled
  },
  execution: {
    maxRows: 100,
    maxBatchRows: 20
  }
});

const clickDerivedSkillControl = async (page, skillName, control) => {
  await page.$eval("[data-web2ai-skill-bar]", (bar, { skillName: expectedSkillName, control: expectedControl }) => {
    const item = Array.from(bar.querySelectorAll("span"))
      .find((node) => node.textContent?.includes(expectedSkillName) && (
        node.querySelector('input[type="checkbox"]') || node.querySelector("button")
      ));
    if (!item) throw new Error(`skill item not found: ${expectedSkillName}`);
    if (expectedControl === "toggle") {
      const input = item.querySelector('input[type="checkbox"]');
      if (!input) throw new Error(`toggle not found for ${expectedSkillName}`);
      input.click();
      return;
    }
    const button = Array.from(item.querySelectorAll("button"))
      .find((node) => node.textContent?.trim() === expectedControl);
    if (!button) throw new Error(`control ${expectedControl} not found for ${expectedSkillName}`);
    button.click();
  }, { skillName, control });
};

const readDerivedColumnTexts = (page, skillId) => page.$$eval(
  `#derived-orders tbody tr td[data-web2ai-derived-column="${skillId}"] [data-web2ai-derived-runtime-note]`,
  (nodes) => nodes.map((node) => node.textContent || "")
);

const waitForDerivedColumnTexts = (page, skillId, matcherText) => page.waitForFunction(
  ({ currentSkillId, text }) => {
    const nodes = Array.from(document.querySelectorAll(
      `#derived-orders tbody tr td[data-web2ai-derived-column="${currentSkillId}"] [data-web2ai-derived-runtime-note]`
    ));
    return nodes.length === 2 && nodes.every((node) => node.textContent?.includes(text));
  },
  {},
  { currentSkillId: skillId, text: matcherText }
);

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

  // The Chat-level switch suppresses only new Ask AI hover actions. Chat,
  // existing context and the launcher remain available, and the setting is
  // synchronized to every frame through storage.sync.
  await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector("#web2ai_table_ask_toggle")?.click());
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector("#web2ai_table_ask_toggle")?.checked === false);
  await page.hover("#orders tbody tr");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(
    await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display === "none"),
    true,
    "disabling the Chat switch must hide the page Ask AI action"
  );
  assert.equal(
    await worker.evaluate(async () => (await chrome.storage.sync.get(["tableAskAiEnabled"])).tableAskAiEnabled),
    false,
    "the Ask AI switch must persist across frames and page reloads"
  );
  await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector("#web2ai_table_ask_toggle")?.click());
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector("#web2ai_table_ask_toggle")?.checked === true);
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
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
    const select = shadow?.querySelector("#web2ai_model_select");
    const tip = Array.from(shadow?.querySelectorAll(".header span") || []).find((node) => node.textContent === "支持图片");
    return select?.selectedOptions?.[0]?.textContent === "Vision E2E" && Boolean(tip);
  });

  // Mirrors the right-click “截图（框选区域）” menu action: background asks the
  // top frame to open Chat and enter the existing region-selection flow.
  await worker.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    if (!tab?.id) throw new Error("fixture tab not found for region screenshot");
    chrome.tabs.sendMessage(tab.id, { type: "START_REGION_SCREENSHOT" }, { frameId: 0 }).catch(() => void 0);
  }, url);
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

  const scrollBeforeMultiCapture = await page.evaluate(() => scrollY);
  await page.evaluate(() => {
    window.__web2aiMultiCaptureProgress = [];
    const observer = new MutationObserver(() => {
      const text = document.querySelector("#web2ai_multi_capture_progress")?.textContent?.trim();
      if (text && !window.__web2aiMultiCaptureProgress.includes(text)) window.__web2aiMultiCaptureProgress.push(text);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    window.__web2aiMultiCaptureProgressObserver = observer;
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    const button = Array.from(host.shadowRoot.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === "多屏截图");
    button.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_toast")?.textContent?.includes("多屏截图加入上下文"), { timeout: 15000 });
  const multiCaptureResult = await page.$eval("#web2ai_overlay_host", (host) => ({
    count: host.shadowRoot.querySelectorAll(".contextScreenshot").length,
    labels: Array.from(host.shadowRoot.querySelectorAll(".contextItem .contextText")).map((node) => node.textContent || "")
  }));
  assert.ok(multiCaptureResult.count >= 3, `multi-screen capture must add several image contexts: ${JSON.stringify(multiCaptureResult)}`);
  assert.equal(await page.evaluate(() => scrollY), scrollBeforeMultiCapture, "multi-screen capture must restore the original scroll position");
  const progressMessages = await page.evaluate(() => {
    window.__web2aiMultiCaptureProgressObserver?.disconnect();
    return window.__web2aiMultiCaptureProgress || [];
  });
  assert.ok(progressMessages.some((text) => text.startsWith("已完成 ")), `multi-screen capture must show per-screen progress: ${JSON.stringify(progressMessages)}`);
  assert.ok(progressMessages.some((text) => text.startsWith("多屏截图完成")), `multi-screen capture must show completion progress: ${JSON.stringify(progressMessages)}`);

  // Multi-source first milestone: bind two same-page tables and one table from
  // another open page, then keep all independent locators after refresh.
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "技能")?.click();
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll("button")).find((button) => button.textContent?.includes("创建技能"))?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => Boolean(host.shadowRoot.querySelector(".skillList"))),
    false,
    "creating a skill must hide the skill catalog below the form to avoid mixing catalog cards with the draft"
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    const name = host.shadowRoot.querySelector(".skillInput");
    const method = host.shadowRoot.querySelector(".skillTextarea");
    name.value = "订单分析";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    method.value = "识别异常订单并说明原因";
    method.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.includes("选择数据源"))?.click();
  });
  await page.waitForSelector("[data-web2ai-ui='skill-picker']");
  await page.hover("#orders");
  await page.$eval("#orders", (node) => node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillSourceItem").length === 1);
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.includes("添加数据源"))?.click();
  });
  await page.waitForSelector("[data-web2ai-ui='skill-picker']");
  await page.hover("#orders-secondary");
  await page.$eval("#orders-secondary", (node) => node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillSourceItem").length === 2);
  const crossSourcePage = await browser.newPage();
  await crossSourcePage.goto(`${url}source-page`);
  await crossSourcePage.waitForSelector("#web2ai_overlay_host");
  await page.bringToFront();
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.includes("添加数据源"))?.click();
  });
  await crossSourcePage.bringToFront();
  await crossSourcePage.waitForSelector("[data-web2ai-ui='skill-picker']");
  await crossSourcePage.hover("#orders");
  await crossSourcePage.$eval("#orders", (node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillSourceItem").length === 3);
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.trim() === "保存")?.click();
  });
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillCard") || []);
    return cards.some((card) => card.textContent?.includes("订单分析"));
  });
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillCard") || []);
    return cards.some((card) => card.textContent?.includes("订单分析") && card.textContent?.includes("分析方法已配置"));
  });
  assert.match(await page.$eval("#web2ai_overlay_host", (host) => {
    const cards = Array.from(host.shadowRoot.querySelectorAll(".skillCard"));
    return cards.find((card) => card.textContent?.includes("订单分析"))?.textContent || "";
  }), /数据源：共 3 个/);
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => {
      const cards = Array.from(host.shadowRoot.querySelectorAll(".skillCard"));
      return cards.find((card) => card.textContent?.includes("订单分析"))?.querySelector(".skillTypeIcon")?.textContent?.trim() || "";
    }),
    "表",
    "table-analysis skills in the plugin panel must show a leading 表 icon before the skill name"
  );
  const skillSummary = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillSummary")?.textContent || "");
  assert.match(skillSummary, /全部技能 1 个/);
  assert.match(skillSummary, /其他页面技能：/);
  await page.$eval("#web2ai_overlay_host", (host) => {
    const card = Array.from(host.shadowRoot.querySelectorAll(".skillCard"))
      .find((node) => node.textContent?.includes("订单分析"));
    Array.from(card?.querySelectorAll("button") || []).find((button) => button.textContent?.trim() === "修改技能")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => Boolean(host.shadowRoot.querySelector(".skillList"))),
    false,
    "editing a skill must hide the catalog below the form so users focus on the current draft"
  );
  assert.equal(await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillInput")?.value), "订单分析");
  assert.equal(await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillSourceItem").length), 3, "modify mode must load every saved data source");
  assert.match(await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillTextarea")?.value || ""), /识别异常订单并说明原因/);
  await page.$eval("#web2ai_overlay_host", (host) => {
    const name = host.shadowRoot.querySelector(".skillInput");
    const method = host.shadowRoot.querySelector(".skillTextarea");
    const firstSourceName = host.shadowRoot.querySelector(".skillSourceNameInput");
    name.value = "订单综合分析";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    method.value = "识别异常订单并说明原因，使用列表输出";
    method.dispatchEvent(new Event("input", { bubbles: true }));
    firstSourceName.value = "主订单明细";
    firstSourceName.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.trim() === "保存修改")?.click();
  });
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillCard") || []);
    return cards.some((card) => card.textContent?.includes("订单综合分析"));
  });
  const modifiedSkill = await page.$eval("#web2ai_overlay_host", (host) => {
    const cards = Array.from(host.shadowRoot.querySelectorAll(".skillCard"));
    return cards.find((card) => card.textContent?.includes("订单综合分析"))?.textContent || "";
  });
  assert.match(modifiedSkill, /主订单明细/, "modified data-source display names must persist");
  assert.match(modifiedSkill, /使用列表输出/, "modified analysis methods must persist");
  await page.bringToFront();
  await page.evaluate(() => history.pushState({}, "", "/another-business-page"));
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(await page.$eval("#web2ai_overlay_host", (host) => Boolean(host.shadowRoot.querySelector(".skillCard"))), false);
  await page.evaluate(() => history.pushState({}, "", "/"));
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.match(await page.$eval("#web2ai_overlay_host", (host) => {
    const cards = Array.from(host.shadowRoot.querySelectorAll(".skillCard"));
    return cards.find((card) => card.textContent?.includes("订单综合分析"))?.textContent || "";
  }), /订单综合分析/);
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll("button")).find((button) => button.textContent?.includes("创建技能"))?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillReuseItem").length),
    2,
    "table-analysis drafts should list the current page's reusable data sources individually"
  );
  await worker.evaluate(async () => {
    const SKILL_STORAGE_KEY = "web2aiSkills";
    const storage = await chrome.storage.local.get([SKILL_STORAGE_KEY]);
    const skills = Array.isArray(storage[SKILL_STORAGE_KEY]) ? storage[SKILL_STORAGE_KEY] : [];
    const target = skills.find((skill) => skill?.name === "订单综合分析");
    if (!target?.sources?.[0]) throw new Error("target skill for legacy-source migration test not found");
    const legacySource = { ...target.sources[0] };
    delete legacySource.framePathHint;
    delete legacySource.locatorVersion;
    target.sources[0] = legacySource;
    target.source = legacySource;
    await chrome.storage.local.set({ [SKILL_STORAGE_KEY]: skills });
  });
  await page.reload();
  await page.waitForSelector("#web2ai_overlay_host");
  await page.$eval("#web2ai_overlay_host", (host) => {
    if (host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")) {
      document.querySelector("#web2ai_launcher_fab")?.click();
    }
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "技能")?.click();
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll("button")).find((button) => button.textContent?.includes("创建技能"))?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillReuseItem").length),
    2,
    "legacy and locator-v2 bindings that point to the same table must still dedupe into one reusable source"
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    const buttons = Array.from(host.shadowRoot.querySelectorAll(".skillReuseItem .btn"));
    buttons[0]?.click();
    buttons[1]?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillSourceItem").length === 2);
  await page.$eval("#web2ai_overlay_host", (host) => {
    const name = host.shadowRoot.querySelector(".skillInput");
    const method = host.shadowRoot.querySelector(".skillTextarea");
    name.value = "订单复用分析";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    method.value = "复用已有数据源进行分析";
    method.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.trim() === "保存")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.textContent?.includes("订单复用分析"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll("button")).find((button) => button.textContent?.includes("创建技能"))?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillReuseItem").length),
    2,
    "duplicate current-page sources reused by another skill must still appear only once in the reuse list"
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.trim() === "取消")?.click();
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  await worker.evaluate(async (baseUrl) => {
    const SKILL_STORAGE_KEY = "web2aiSkills";
    const SKILL_PAGE_NAMES_STORAGE_KEY = "web2aiSkillPageNames";
    const storage = await chrome.storage.local.get([SKILL_STORAGE_KEY, SKILL_PAGE_NAMES_STORAGE_KEY]);
    const existingSkills = Array.isArray(storage[SKILL_STORAGE_KEY]) ? storage[SKILL_STORAGE_KEY] : [];
    const pageNames = storage[SKILL_PAGE_NAMES_STORAGE_KEY] || {};
    const now = Date.now();
    const extraSkills = Array.from({ length: 8 }, (_, index) => {
      const pageUrl = `${baseUrl}catalog-page-${index + 1}`;
      return {
        id: `global-catalog-skill-${index + 1}`,
        type: "table-analysis",
        name: `全局技能${index + 1}`,
        revision: 1,
        createdAt: now + index,
        updatedAt: now + index,
        pageKey: pageUrl,
        pageUrl,
        pageTitle: `全局技能页面 ${index + 1}`,
        analysisMethod: { description: `全局分析方法 ${index + 1}` },
        sources: [{
          id: `global-catalog-skill-${index + 1}-source`,
          pageKey: pageUrl,
          pageUrl,
          pageTitle: `全局技能页面 ${index + 1}`,
          frameUrl: pageUrl,
          selector: "#orders",
          tableIndex: 0,
          headers: ["订单号", "订单状态", "金额", "备注"]
        }]
      };
    });
    await chrome.storage.local.set({
      [SKILL_STORAGE_KEY]: [...existingSkills, ...extraSkills],
      [SKILL_PAGE_NAMES_STORAGE_KEY]: {
        ...pageNames,
        ...Object.fromEntries(extraSkills.map((skill, index) => [
          skill.pageKey,
          `全局技能目录页面 ${index + 1}`
        ]))
      }
    });
  }, url);
  await page.reload();
  await page.waitForSelector("#web2ai_overlay_host");
  await page.$eval("#web2ai_overlay_host", (host) => {
    if (host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")) {
      document.querySelector("#web2ai_launcher_fab")?.click();
    }
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".wrap")?.classList.contains("hidden"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "技能")?.click();
  });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
    return shadow?.querySelectorAll(".skillCard").length === 2 && shadow.querySelector(".skillToggleList");
  });
  const collapsedGlobalCatalog = await page.$eval("#web2ai_overlay_host", (host) => {
    const wrap = host.shadowRoot.getElementById("web2ai_skill_pages_wrap");
    const toggle = host.shadowRoot.querySelector(".skillToggleList");
    return {
      currentPageCards: host.shadowRoot.querySelectorAll(".skillCard").length,
      toggleText: toggle?.textContent?.trim() || "",
      clientHeight: wrap?.clientHeight || 0,
      scrollHeight: wrap?.scrollHeight || 0
    };
  });
  assert.equal(
    collapsedGlobalCatalog.currentPageCards,
    2,
    "collapsing the global skill catalog must not hide current-page skill cards"
  );
  assert.equal(
    collapsedGlobalCatalog.toggleText,
    "展开",
    "the global skill catalog should default to collapsed when it exceeds two rows"
  );
  assert.ok(
    collapsedGlobalCatalog.scrollHeight > collapsedGlobalCatalog.clientHeight,
    `the global skill catalog should be height-clamped by default: ${JSON.stringify(collapsedGlobalCatalog)}`
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillToggleList")).find((button) => button.textContent?.trim() === "展开")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillToggleList")?.textContent?.trim() === "收起");
  const expandedGlobalCatalog = await page.$eval("#web2ai_overlay_host", (host) => {
    const wrap = host.shadowRoot.getElementById("web2ai_skill_pages_wrap");
    return {
      currentPageCards: host.shadowRoot.querySelectorAll(".skillCard").length,
      clientHeight: wrap?.clientHeight || 0,
      scrollHeight: wrap?.scrollHeight || 0
    };
  });
  assert.equal(
    expandedGlobalCatalog.currentPageCards,
    2,
    "expanding the global skill catalog must still keep current-page skill cards intact"
  );
  assert.ok(
    expandedGlobalCatalog.clientHeight >= expandedGlobalCatalog.scrollHeight - 1,
    `expanding the global skill catalog should reveal the full list: ${JSON.stringify(expandedGlobalCatalog)}`
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillToggleList")).find((button) => button.textContent?.trim() === "收起")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillToggleList")?.textContent?.trim() === "展开");
  const recollapsedGlobalCatalog = await page.$eval("#web2ai_overlay_host", (host) => {
    const wrap = host.shadowRoot.getElementById("web2ai_skill_pages_wrap");
    return {
      currentPageCards: host.shadowRoot.querySelectorAll(".skillCard").length,
      clientHeight: wrap?.clientHeight || 0,
      scrollHeight: wrap?.scrollHeight || 0
    };
  });
  assert.equal(
    recollapsedGlobalCatalog.currentPageCards,
    2,
    "collapsing the global skill catalog again must not affect current-page skill cards"
  );
  assert.ok(
    recollapsedGlobalCatalog.scrollHeight > recollapsedGlobalCatalog.clientHeight,
    `collapsing again should restore the two-row global catalog clamp: ${JSON.stringify(recollapsedGlobalCatalog)}`
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "Chat")?.click();
  });

  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "技能")?.click();
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll("button")).find((button) => button.textContent?.includes("创建技能"))?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    const derivedButton = Array.from(host.shadowRoot.querySelectorAll(".skillForm button"))
      .find((button) => button.textContent?.trim() === "按列分析");
    derivedButton?.click();
  });
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillReuseItem").length),
    2,
    "derived-column drafts should also list reusable current-page data sources"
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    host.shadowRoot.querySelector(".skillReuseItem .btn")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.textContent?.includes("用于分析的字段"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => Boolean(host.shadowRoot.querySelector(".skillForm .skillTypeIcon"))),
    false,
    "draft forms must not reuse card-only type icons"
  );
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => {
      const field = Array.from(host.shadowRoot.querySelectorAll(".skillField"))
        .find((node) => node.textContent?.includes("新增列名称"));
      return field?.querySelector(".skillInput")?.value || "";
    }),
    "智能分析结论",
    "derived-column drafts must default the output column name to 智能分析结论"
  );
  const scrollState = await page.$eval("#web2ai_overlay_host", (host) => {
    const panel = host.shadowRoot.getElementById("web2ai_skills_body");
    const block = Array.from(host.shadowRoot.querySelectorAll(".skillBlockTitle"))
      .find((node) => node.textContent?.includes("用于分析的字段"));
    block?.scrollIntoView({ block: "start" });
    panel.scrollTop += 120;
    const inputs = Array.from(block?.parentElement?.querySelectorAll('input[type="checkbox"]') || []);
    const before = panel.scrollTop;
    inputs[0]?.click();
    const afterFirst = host.shadowRoot.getElementById("web2ai_skills_body")?.scrollTop || 0;
    const refreshedBlock = Array.from(host.shadowRoot.querySelectorAll(".skillBlockTitle"))
      .find((node) => node.textContent?.includes("用于分析的字段"));
    const refreshedInputs = Array.from(refreshedBlock?.parentElement?.querySelectorAll('input[type="checkbox"]') || []);
    refreshedInputs[1]?.click();
    const afterSecond = host.shadowRoot.getElementById("web2ai_skills_body")?.scrollTop || 0;
    return { before, afterFirst, afterSecond };
  });
  assert.ok(
    Math.abs(scrollState.afterFirst - scrollState.before) < 24,
    `selecting the first derived field must keep the skills panel near the current scroll position: ${JSON.stringify(scrollState)}`
  );
  assert.ok(
    Math.abs(scrollState.afterSecond - scrollState.afterFirst) < 24,
    `selecting more derived fields must not jump the panel back to the top: ${JSON.stringify(scrollState)}`
  );
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillForm button")).find((button) => button.textContent?.trim() === "取消")?.click();
  });
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillForm"));
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "Chat")?.click();
  });

  await page.$eval("#web2ai_overlay_host", (host) => {
    const clearContext = Array.from(host.shadowRoot.querySelectorAll(".contextSec .sectionHead button"))
      .find((button) => button.textContent?.trim() === "清空上下文");
    clearContext?.click();
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

  await page.$eval("#reuse-no-key", (button) => button.click());
  await page.waitForFunction(() => document.querySelector("#no-key-row")?.textContent?.includes("No key reused"));
  await reenterRow(page, noKeyRow);
  const noKeyRecycledAskVisible = await page.$eval("#web2ai_table_row_ask_ai", (button) => button.parentElement?.style.display !== "none");
  assert.equal(noKeyRecycledAskVisible, true, "leading-column fingerprint must detect a recycled row without rowKey");
  await clickInlineCheckbox(page);
  const noKeyReusedLabel = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".tableGroupLabel")?.textContent || "");
  assert.match(noKeyReusedLabel, /4 条/, "the recycled keyless row must be added as a new snapshot");

  await page.$eval("#reuse", (button) => button.click());
  await page.waitForFunction(() => document.querySelector("#order-reused")?.textContent?.includes("Reused"));
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

  await page.$eval("#replace", (button) => button.click());
  await page.waitForFunction(() => document.querySelector("#order-3")?.textContent?.includes("C"));
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
  await page.$eval("#web2ai_launcher_fab", (button) => button.click());
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".sideTab")).find((button) => button.textContent?.trim() === "技能")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillCard .skillStatus.available"));
  const restoredSkill = await page.$eval("#web2ai_overlay_host", (host) => {
    const cards = Array.from(host.shadowRoot.querySelectorAll(".skillCard"));
    return cards.find((card) => card.textContent?.includes("订单综合分析"))?.textContent || "";
  });
  assert.match(restoredSkill, /订单综合分析/);
  assert.match(restoredSkill, /数据源：共 3 个/, "same-page and cross-page data sources must survive refresh");
  assert.match(restoredSkill, /主订单明细/);
  assert.match(restoredSkill, /分析方法：识别异常订单并说明原因，使用列表输出/);

  // Test mode must load every source before it attempts the model request.
  // Point the active test profile at this fixture's local OpenAI-compatible
  // endpoint so method saving can also be verified after a completed run.
  await worker.evaluate(async (baseUrl) => {
    const { settings } = await chrome.storage.sync.get(["settings"]);
    // A page refresh intentionally resets the content-side selection to the
    // default profile. Point every configured test profile at the local model
    // so this assertion does not depend on which valid profile the page kept.
    const models = settings.models.map((profile) => ({ ...profile, baseUrl, model: "e2e-local" }));
    const { modelApiKeys = {} } = await chrome.storage.local.get(["modelApiKeys"]);
    const localKeys = Object.fromEntries(models.map((profile) => [profile.id, "e2e-key"]));
    await Promise.all([
      chrome.storage.sync.set({ settings: { ...settings, models } }),
      chrome.storage.local.set({ modelApiKeys: { ...modelApiKeys, ...localKeys } })
    ]);
  }, url);
  await page.$eval("#web2ai_overlay_host", (host) => {
    const card = Array.from(host.shadowRoot.querySelectorAll(".skillCard"))
      .find((node) => node.textContent?.includes("订单综合分析"));
    Array.from(card?.querySelectorAll("button") || []).find((button) => button.textContent?.trim() === "测试技能")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillTest"));
  const fileChooserPromise = page.waitForFileChooser();
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillTestPanel button")).find((button) => button.textContent?.includes("上传 CSV"))?.click();
  });
  const fileChooser = await fileChooserPromise;
  await fileChooser.accept([runtimeCsv]);
  await page.waitForFunction(() => (
    document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillDataSourceTab").length === 4
  ));
  const uploadedPreview = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillTestPanel")?.textContent || "");
  assert.match(uploadedPreview, /runtime-orders.csv/);
  assert.match(uploadedPreview, /共 2 条/, "uploaded CSV must be parsed and previewed as a runtime source");

  // A pagination prompt is extension UI. Cancelling it must abort only this run,
  // keep the full-screen workspace visible, and leave the source retryable.
  await page.$eval("#orders", (table) => {
    const pagination = document.createElement("ul");
    pagination.id = "e2e-cancel-pagination";
    pagination.className = "ant-pagination";
    pagination.innerHTML = '<li class="ant-pagination-next"><button aria-label="下一页">下一页</button></li>';
    table.parentElement.appendChild(pagination);
  });
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillTestPanel button")).find((button) => button.textContent?.trim() === "开始测试")?.click();
  });
  await page.waitForFunction(() => document.querySelector("[data-web2ai-ui='dialog']")?.shadowRoot?.querySelector(".message")?.textContent?.includes("输入 0 表示全部"));
  const collectionResultStatus = await page.$eval("#web2ai_overlay_host", (host) => {
    const node = host.shadowRoot.querySelector(".skillResultStatus");
    return node ? { text: node.textContent, fontSize: getComputedStyle(node).fontSize } : null;
  });
  assert.deepEqual(
    collectionResultStatus,
    { text: "正在采集数据...", fontSize: "14px" },
    "the result panel must visibly distinguish data collection from model analysis"
  );
  await page.$eval("[data-web2ai-ui='dialog']", (host) => host.shadowRoot.querySelector(".cancel")?.click());
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
    return !document.querySelector("[data-web2ai-ui='dialog']") &&
      shadow?.querySelector(".skillTestError")?.textContent?.includes("已取消数据源载入") &&
      !shadow.querySelector(".skillTestHead button")?.disabled;
  });
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")),
    false,
    "cancelling page-count selection must keep the skill workspace visible"
  );
  await page.$eval("#e2e-cancel-pagination", (pagination) => pagination.remove());

  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillTestPanel button")).find((button) => button.textContent?.trim() === "开始测试")?.click();
  });
  try {
    await page.waitForFunction(() => {
      const shadow = document.querySelector("#web2ai_overlay_host")?.shadowRoot;
      return shadow?.querySelectorAll(".skillDataSourceTab.complete").length === 4 && !shadow.querySelector(".skillTestHead button")?.disabled;
    }, { timeout: 30000 });
  } catch (error) {
    const workspace = await page.$eval("#web2ai_overlay_host", (host) => ({
      tabs: Array.from(host.shadowRoot.querySelectorAll(".skillDataSourceTab")).map((tab) => ({
        className: tab.className,
        text: tab.textContent || ""
      })),
      error: host.shadowRoot.querySelector(".skillTestError")?.textContent || "",
      preview: host.shadowRoot.querySelector(".skillDataPreviewStatus")?.textContent || ""
    }));
    workspace.sources = [];
    for (let index = 0; index < workspace.tabs.length; index++) {
      await page.$eval("#web2ai_overlay_host", (host, sourceIndex) => {
        host.shadowRoot.querySelectorAll(".skillDataSourceTab")[sourceIndex]?.click();
      }, index);
      await new Promise((resolve) => setTimeout(resolve, 50));
      workspace.sources.push(await page.$eval("#web2ai_overlay_host", (host) => ({
        status: host.shadowRoot.querySelector(".skillDataPreviewStatus")?.textContent || "",
        error: host.shadowRoot.querySelector(".skillTestError")?.textContent || ""
      })));
    }
    throw new Error(`skill test did not complete all sources: ${JSON.stringify(workspace)}`, { cause: error });
  }
  assert.ok(aiRequestCount > 0, "the completed skill test must reach the local model fixture");
  const testedSources = await page.$eval("#web2ai_overlay_host", (host) =>
    Array.from(host.shadowRoot.querySelectorAll(".skillDataSourceTab")).map((tab) => tab.textContent || "")
  );
  assert.equal(testedSources.length, 4, "test mode must combine configured sources with the uploaded runtime source");
  assert.ok(testedSources.every((label) => /共 \d+ 条/.test(label)), `test mode must show a row count for every source: ${JSON.stringify(testedSources)}`);
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillActions button")).find((button) => button.textContent?.trim() === "查看提交内容")?.click();
  });
  await page.waitForSelector("[data-web2ai-ui='dialog']");
  const submittedSnapshot = await page.$eval("[data-web2ai-ui='dialog']", (host) => host.shadowRoot.querySelector("textarea")?.value || "");
  assert.match(submittedSnapshot, /【分析任务】/);
  assert.match(submittedSnapshot, /runtime-orders.csv/);
  assert.match(submittedSnapshot, /\| 线上 \| 12 \|  \|/, "submitted-content viewer must show the exact runtime CSV row");
  await page.$eval("[data-web2ai-ui='dialog']", (host) => host.shadowRoot.querySelector(".cancel")?.click());
  await page.waitForFunction(() => !document.querySelector("[data-web2ai-ui='dialog']"));
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".wrap")?.classList.contains("hidden")),
    false,
    "cancelling an extension dialog must keep the skill workspace visible"
  );
  const savedTestMethod = "识别异常订单、解释原因，并按风险级别输出";
  const saveButtonState = await page.$eval("#web2ai_overlay_host", (host, methodText) => {
    const textarea = host.shadowRoot.querySelector(".skillTestMethod");
    textarea.value = methodText;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const saveButton = Array.from(host.shadowRoot.querySelectorAll(".skillActions button"))
      .find((button) => button.textContent?.trim() === "满意并保存");
    const state = {
      found: Boolean(saveButton),
      disabled: Boolean(saveButton?.disabled),
      panelText: host.shadowRoot.querySelector(".skillTest")?.textContent || ""
    };
    saveButton?.click();
    return state;
  }, savedTestMethod);
  assert.deepEqual(
    { found: saveButtonState.found, disabled: saveButtonState.disabled },
    { found: true, disabled: false },
    `a completed test must enable method saving: ${saveButtonState.panelText}`
  );
  // A save starts with an immediate UI lock. Clicking Back during the storage
  // round-trip must neither leave the workspace nor open an unsaved dialog.
  await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillTestHead button")?.click());
  const saveRaceDialog = await page.$eval("[data-web2ai-ui='dialog']", (host) => host.shadowRoot.querySelector(".message")?.textContent || "").catch(() => null);
  assert.equal(saveRaceDialog, null, `saving a method must not race with the unsaved-change prompt: ${saveRaceDialog || ""}`);
  await page.waitForFunction(() => document.querySelector("#web2ai_toast")?.textContent?.includes("分析方法已保存"));
  await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillTestHead button")?.click());
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillTest"));
  assert.equal(await page.$("[data-web2ai-ui='dialog']"), null, "a persisted method must return without another save prompt");
  assert.match(
    await page.$eval("#web2ai_overlay_host", (host) => {
      const cards = Array.from(host.shadowRoot.querySelectorAll(".skillCard"));
      return cards.find((card) => card.textContent?.includes("订单综合分析"))?.textContent || "";
    }),
    /按风险级别输出/,
    "the method saved from test mode must update the persisted skill card"
  );

  await page.waitForFunction(() => document.querySelector("[data-web2ai-skill-bar]")?.textContent?.includes("订单综合分析"));
  const skillBarText = await page.$eval("[data-web2ai-skill-bar]", (bar) => bar.textContent || "");
  assert.match(skillBarText, /技能列表：.*订单综合分析.*执行/, "bound skills must appear above their data source");
  await page.$eval("[data-web2ai-skill-bar]", (bar) => {
    const item = Array.from(bar.querySelectorAll("span"))
      .find((node) => node.textContent?.includes("订单综合分析") && node.querySelector("button"));
    item?.querySelector("button")?.click();
  });
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillExecution"));
  const executionTitle = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillExecutionTitle")?.textContent || "");
  assert.match(executionTitle, /订单综合分析/);
  const testIsFullscreen = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".wrap")?.classList.contains("max"));
  assert.equal(testIsFullscreen, true, "skill testing must use the full-screen interaction");
  assert.equal(
    await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillDataSourceTab").length),
    3,
    "the CSV uploaded in test mode must be released before execution mode opens"
  );
  const executionFileChooserPromise = page.waitForFileChooser();
  await page.$eval("#web2ai_overlay_host", (host) => {
    Array.from(host.shadowRoot.querySelectorAll(".skillExecutionPanel button")).find((button) => button.textContent?.includes("上传 CSV"))?.click();
  });
  const executionFileChooser = await executionFileChooserPromise;
  await executionFileChooser.accept([runtimeXlsx]);
  await page.waitForFunction(() => (
    document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelectorAll(".skillDataSourceTab").length === 4
  ));
  const xlsxPreview = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillExecutionPanel")?.textContent || "");
  assert.match(xlsxPreview, /runtime-after-sales.xlsx \/ 售后明细/);
  assert.match(xlsxPreview, /R-100/);
  await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector("#web2ai_run_skill")?.click());
  await page.waitForFunction(() => document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillDataPreviewStatus")?.textContent?.includes("本次使用"));
  const loadedSkillData = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillExecutionPanel")?.textContent || "");
  assert.match(loadedSkillData, /已读取 \d+ 行，本次使用 \d+ 行/);
  const executedSources = await page.$eval("#web2ai_overlay_host", (host) =>
    Array.from(host.shadowRoot.querySelectorAll(".skillDataSourceTab")).map((tab) => tab.textContent || "")
  );
  assert.equal(executedSources.length, 4, "execution mode must combine configured sources with its own uploaded XLSX source");
  assert.ok(executedSources.every((label) => /共 \d+ 条/.test(label)), `execution mode must show a row count for every source: ${JSON.stringify(executedSources)}`);
  const previewedSkillRows = await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".skillDataPreview tbody tr").length);
  assert.ok(previewedSkillRows > 0 && previewedSkillRows <= 10, "skill execution must preview up to ten loaded rows per page");
  const firstPreviewCells = await page.$eval("#web2ai_overlay_host", (host) =>
    Array.from(host.shadowRoot.querySelectorAll(".skillDataPreview tbody tr:first-child td")).map((cell) => cell.textContent || "")
  );
  assert.deepEqual(firstPreviewCells, ["1", "A", "", "100"], "empty business cells must remain in their original columns");
  await page.waitForFunction(() => !document.querySelector("#web2ai_overlay_host")?.shadowRoot?.querySelector(".skillExecutionHead button")?.disabled, { timeout: 15000 });
  await page.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelector(".skillExecutionHead button")?.click());

  const innerPage = await browser.newPage();
  await innerPage.goto(`${url}inner-frame-host`);
  await innerPage.bringToFront();
  await innerPage.waitForSelector("#web2ai_overlay_host");
  const scrollingFrame = await innerPage.waitForFrame((frame) => frame.url().endsWith("/inner-scroll"));
  await scrollingFrame.$eval("#scrollbox", (node) => { node.scrollTop = 120; });
  await worker.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    if (!tab?.id) throw new Error("inner-frame tab not found for multi-screen screenshot");
    chrome.tabs.sendMessage(tab.id, { type: "START_MULTI_SCREEN_SCREENSHOT" }, { frameId: 0 }).catch(() => void 0);
  }, `${url}inner-frame-host`);
  await innerPage.waitForFunction(() => document.querySelector("#web2ai_toast")?.textContent?.includes("多屏截图加入上下文"), { timeout: 15000 });
  assert.ok(
    await innerPage.$eval("#web2ai_overlay_host", (host) => host.shadowRoot.querySelectorAll(".contextScreenshot").length) >= 4,
    "multi-screen capture must scroll an internal overflow container"
  );
  assert.equal(await scrollingFrame.$eval("#scrollbox", (node) => node.scrollTop), 120, "child-frame scroll position must be restored");
  await innerPage.close();

  // A hybrid data source may open every page in the middle with earlier rows
  // already recycled. The collector must reset each page before its first read,
  // scroll through all recycled rows, then restore page 1 and the scroll top.
  const virtualPage = await browser.newPage();
  await virtualPage.goto(`${url}virtual-collection`);
  await virtualPage.waitForSelector("#web2ai_overlay_host");
  const virtualCollection = await worker.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    if (!tab?.id) throw new Error("virtual collection tab not found");
    return chrome.tabs.sendMessage(tab.id, {
      type: "COLLECT_SKILL_SOURCE_DATA",
      source: { selector: "#virtual-table", tableIndex: 0, headers: ["序号", "订单号"] },
      options: { collectionId: "e2e-virtual-collection", maxPages: 2, maxRows: 100 }
    }, { frameId: 0 });
  }, `${url}virtual-collection`);
  assert.equal(virtualCollection?.ok, true, `virtual collection failed: ${JSON.stringify(virtualCollection)}`);
  assert.equal(virtualCollection.data.collectedPages, 2);
  assert.equal(virtualCollection.data.rowCount, 24, "collector must read all recycled rows before each page turn");
  assert.deepEqual(
    virtualCollection.data.rows.filter((row) => row[0] === "1").map((row) => row[1]),
    ["P1-ORDER-1", "P2-ORDER-1"],
    "each paginated virtual list must be reset before its first rendered rows are recorded"
  );
  assert.equal(await virtualPage.$eval("#virtual-scroll", (node) => node.scrollTop), 0, "virtual table must return to the top");
  assert.equal(await virtualPage.$eval(".ant-pagination-item-active", (node) => node.textContent.trim()), "1", "hybrid collection must restore page one");
  await virtualPage.close();

  const derivedRuntimeUrl = `${url}derived-runtime`;
  await setDerivedRuntimeSkills(worker, {
    pageUrl: derivedRuntimeUrl,
    pageRequestLimitPerMinute: 1,
    skills: [
      makeDerivedSkill({
        id: "derived-auto-a",
        name: "自动风险A",
        pageUrl: derivedRuntimeUrl,
        columnName: "风险A",
        autoRunEnabled: true
      }),
      makeDerivedSkill({
        id: "derived-auto-b",
        name: "自动风险B",
        pageUrl: derivedRuntimeUrl,
        columnName: "风险B",
        autoRunEnabled: true
      })
    ]
  });
  const derivedPage = await browser.newPage();
  await derivedPage.goto(derivedRuntimeUrl);
  await derivedPage.waitForSelector("#web2ai_overlay_host");
  await derivedPage.waitForFunction(() => document.querySelector("[data-web2ai-skill-bar]")?.textContent?.includes("自动风险A"));
  await waitForDerivedColumnTexts(derivedPage, "derived-auto-a", "E2E结论");
  await waitForDerivedColumnTexts(derivedPage, "derived-auto-b", "当前页面已触发访问保护");
  assert.deepEqual(
    await derivedPage.$eval("#derived-orders thead tr", (row) => Array.from(row.children).map((cell) => cell.textContent.trim())),
    ["订单号", "风险A", "风险B", "金额", "状态"],
    "derived runtime must insert native result columns before the first selected business column"
  );
  const derivedBlockedCheckpoint = derivedAiRequestCount;
  await derivedPage.$eval("#derived-rerender", (button) => button.click());
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(
    derivedAiRequestCount,
    derivedBlockedCheckpoint,
    "same-page rerender must not trigger new model requests while the blocked list stays unchanged"
  );
  await clickDerivedSkillControl(derivedPage, "自动风险B", "更新");
  await waitForDerivedColumnTexts(derivedPage, "derived-auto-b", "E2E结论");
  assert.equal(
    derivedAiRequestCount,
    derivedBlockedCheckpoint + 1,
    "manual refresh must bypass the page guard and complete the blocked derived column"
  );
  await clickDerivedSkillControl(derivedPage, "自动风险A", "toggle");
  await derivedPage.waitForFunction(() => {
    const bar = document.querySelector("[data-web2ai-skill-bar]");
    const item = Array.from(bar?.querySelectorAll("span") || [])
      .find((node) => node.textContent?.includes("自动风险A") && node.querySelector('input[type="checkbox"]'));
    return item?.querySelector('input[type="checkbox"]')?.checked === false;
  });
  const beforeListChangeCount = derivedAiRequestCount;
  await derivedPage.$eval("#derived-page-2", (button) => button.click());
  await derivedPage.waitForFunction(() => document.querySelector("#derived-current-page")?.textContent?.trim() === "2");
  await waitForDerivedColumnTexts(derivedPage, "derived-auto-b", "当前页面已触发访问保护");
  assert.equal(
    derivedAiRequestCount,
    beforeListChangeCount,
    "list changes may unlock auto-run scheduling, but the request must still be blocked by the page-level total budget"
  );
  const beforeReturnToFirstPage = derivedAiRequestCount;
  await derivedPage.$eval("#derived-page-1", (button) => button.click());
  await derivedPage.waitForFunction(() => document.querySelector("#derived-current-page")?.textContent?.trim() === "1");
  await waitForDerivedColumnTexts(derivedPage, "derived-auto-b", "E2E结论");
  assert.deepEqual(
    await readDerivedColumnTexts(derivedPage, "derived-auto-b"),
    ["E2E结论1", "E2E结论2"],
    "returning to a previously analyzed page must restore its cached derived results"
  );
  assert.equal(
    derivedAiRequestCount,
    beforeReturnToFirstPage,
    "returning to a previously analyzed page must reuse cached derived results instead of requesting the model again"
  );
  await derivedPage.close();

  await setDerivedRuntimeSkills(worker, {
    pageUrl: derivedRuntimeUrl,
    pageRequestLimitPerMinute: 5,
    skills: [
      makeDerivedSkill({
        id: "derived-manual-only",
        name: "手动分析列",
        pageUrl: derivedRuntimeUrl,
        columnName: "手动结论",
        autoRunEnabled: false
      })
    ]
  });
  const derivedManualPage = await browser.newPage();
  await derivedManualPage.goto(derivedRuntimeUrl);
  await derivedManualPage.waitForSelector("#web2ai_overlay_host");
  await derivedManualPage.waitForFunction(() => document.querySelector("[data-web2ai-skill-bar]")?.textContent?.includes("手动分析列"));
  assert.equal(
    await derivedManualPage.$("[data-web2ai-derived-column-header=\"derived-manual-only\"]"),
    null,
    "auto-disabled derived skills must not render native result columns before a manual refresh"
  );
  const manualBeforeUpdate = derivedAiRequestCount;
  await clickDerivedSkillControl(derivedManualPage, "手动分析列", "更新");
  await waitForDerivedColumnTexts(derivedManualPage, "derived-manual-only", "E2E结论");
  assert.equal(
    derivedAiRequestCount,
    manualBeforeUpdate + 1,
    "manual-only derived skills must still request the model when the user clicks refresh"
  );
  await derivedManualPage.$eval("#derived-page-2", (button) => button.click());
  await derivedManualPage.waitForFunction(() => document.querySelector("#derived-current-page")?.textContent?.trim() === "2");
  await derivedManualPage.waitForFunction(
    () => !document.querySelector('[data-web2ai-derived-column-header="derived-manual-only"]') &&
      !document.querySelector('#derived-orders tbody td[data-web2ai-derived-column="derived-manual-only"]')
  );
  assert.deepEqual(
    await derivedManualPage.$eval("#derived-orders thead tr", (row) => Array.from(row.children).map((cell) => cell.textContent.trim())),
    ["订单号", "金额", "状态"],
    "turning pages with auto execution disabled must clear stale derived columns instead of misaligning the table"
  );
  await derivedManualPage.close();

  // Adding a model is a separate draft flow: it must not appear in the
  // existing-model selector until saved, and cancel must restore edit mode.
  const extensionId = new URL(extensionTarget.url()).host;
  const optionsPage = await browser.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options.html`);
  await optionsPage.waitForSelector("#profile option");
  const profileCountBeforeAdd = await optionsPage.$$eval("#profile option", (options) => options.length);
  await optionsPage.click("#addProfile");
  assert.equal(await optionsPage.$eval("#createTitle", (node) => node.hidden), false, "add model must enter a separate create mode");
  assert.deepEqual(await optionsPage.$$eval("#baseUrl,#model", (inputs) => inputs.map((input) => input.value)), ["", ""], "additional model draft must start blank");
  assert.equal(await optionsPage.$$eval("#profile option", (options) => options.length), profileCountBeforeAdd, "unsaved model must not enter the existing-model list");
  await optionsPage.click("#cancelAdd");
  assert.equal(await optionsPage.$eval("#createTitle", (node) => node.hidden), true, "cancel must return to existing-model edit mode");
  assert.equal(await optionsPage.$$eval("#profile option", (options) => options.length), profileCountBeforeAdd);
  await optionsPage.close();

console.log("Chrome E2E passed: model switching/configuration, screenshots, skill create/edit/test/execute, runtime CSV/XLSX sources, multi-source persistence/loading, hybrid virtual pagination, internal scrolling, launcher toggle, table gating, iframe injection, virtual rows, refresh clearing, derived runtime auto/manual/page-guard coverage");
} finally {
  await browser.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
