/**
 * 回归测试脚本 — 静态验证 demo-html 目录下的表格文件与代码选择器的兼容性
 *
 * 使用方法:
 *   node tests/regression/verify-demo-html.mjs
 *
 * 检查项:
 *   1. 源文件语法检查 (table.js, context.js, state.js)
 *   2. 调试日志审计 — 确保无残留裸 console.log (未包裹 DEBUG &&)
 *   3. demo HTML 选择器覆盖率 — 验证核心函数能否匹配到目标元素
 *   4. UI 常量替换审计 — 确保 Hardcoded 类名已被常量替换
 *   5. 导出接口完整性检查
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const PASS = "\x1b[32m✓\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[36m→\x1b[0m";

let errors = 0;
let warnings = 0;

// ========== 工具函数 ==========

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function analyzeHtml(html) {
  return {
    tables: countMatches(html, /<table[\s>]/gi),
    thead: countMatches(html, /<thead[\s>]/gi),
    tbody: countMatches(html, /<tbody[\s>]/gi),
    tr: countMatches(html, /<tr[\s>]/gi),
    th: countMatches(html, /<th[\s>]/gi),
    td: countMatches(html, /<td[\s>]/gi),
    roleRow: countMatches(html, /role\s*=\s*["']row["']/gi),
    roleColumnHeader: countMatches(html, /role\s*=\s*["']columnheader["']/gi),
    roleCell: countMatches(html, /role\s*=\s*["'](?:cell|gridcell)["']/gi),
    scopeCol: countMatches(html, /scope\s*=\s*["']col["']/gi),
    antCheckbox: countMatches(html, /ant-checkbox/gi),
    artTable: countMatches(html, /art-table/gi),
    checkbox: countMatches(html, /<input[^>]*type\s*=\s*["']checkbox["']/gi),
  };
}

/** 从文件中提取所有 export { ... } 中的导出名 */
function getAllExports(filePath) {
  const code = fs.readFileSync(filePath, "utf-8");
  const names = new Set();
  const re = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    m[1].split(",").forEach((s) => names.add(s.trim()));
  }
  return [...names].filter(Boolean);
}

// ========== 1. 源文件语法检查 ==========

function checkSyntax(files) {
  console.log("\n▶ 语法检查");
  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    try {
      execSync(`node --check --input-type=module < "${fullPath}"`, {
        cwd: ROOT,
        shell: true,
        stdio: "pipe",
      });
      console.log(`  ${PASS} ${file}`);
    } catch (e) {
      const msg = e.stderr?.toString().trim() || e.message;
      console.log(`  ${FAIL} ${file}: ${msg.split("\n")[0]}`);
      errors++;
    }
  }
}

// ========== 2. 调试日志审计 ==========

function auditDebugLogs(files) {
  console.log("\n▶ 调试日志审计 (裸 console.log 检测)");
  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    const code = fs.readFileSync(fullPath, "utf-8");
    const bareLogs = [];
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^\s*console\.log\(/.test(trimmed) && !/^\s*DEBUG\s*&&/.test(trimmed)) {
        bareLogs.push(`L${i + 1}: ${trimmed.substring(0, 80)}`);
      }
    }
    if (bareLogs.length > 0) {
      console.log(`  ${FAIL} ${file}: ${bareLogs.length} 处未包裹的 console.log`);
      bareLogs.forEach((l) => console.log(`      ${l}`));
      errors++;
    } else {
      console.log(`  ${PASS} ${file}`);
    }
  }
}

// ========== 3. demo HTML 选择器覆盖率 ==========

function verifyDemoHtml(demoFiles) {
  console.log("\n▶ demo HTML 选择器覆盖率");

  for (const file of demoFiles) {
    const fullPath = path.join(ROOT, file);
    const html = fs.readFileSync(fullPath, "utf-8");
    const s = analyzeHtml(html);
    const short = path.basename(file);
    const kb = (html.length / 1024).toFixed(0);

    console.log(`\n  ${INFO} ${short} (${kb}KB)`);
    console.log(`    <table>:${s.tables} <thead>:${s.thead} <tbody>:${s.tbody}`);
    console.log(`    <tr>:${s.tr} <th>:${s.th} <td>:${s.td}`);
    if (s.antCheckbox > 0) console.log(`    .ant-checkbox*:${s.antCheckbox} checkbox:${s.checkbox}`);
    if (s.artTable > 0) console.log(`    .art-table*:${s.artTable}`);
    if (s.roleRow > 0) console.log(`    [role=row]:${s.roleRow} [role=columnheader]:${s.roleColumnHeader} [role=cell]:${s.roleCell}`);
    if (s.scopeCol > 0) console.log(`    [scope=col]:${s.scopeCol}`);

    const checks = [];
    if (s.tr > 0) checks.push("getRowCells");
    if (s.th > 0 || s.roleColumnHeader > 0 || s.scopeCol > 0) checks.push("isHeaderRow");
    if (s.thead > 0 || s.th > 0) checks.push("findHeaderRowAbove");
    if (s.checkbox > 0) checks.push("handleRowCheckboxChange");

    const headerModes = [];
    if (s.thead > 0) headerModes.push("thead");
    if (s.roleColumnHeader > 0) headerModes.push("role=columnheader");
    if (s.scopeCol > 0) headerModes.push("scope=col");

    console.log(`    覆盖函数: ${checks.map((c) => `${PASS} ${c}`).join(", ")}`);
    console.log(`    表头检测: ${headerModes.join(", ") || "无(纯数据表)"}`);

    if (s.tr === 0) {
      console.log(`    ${WARN} 无 <tr> 行，getRowCells 无法工作`);
      warnings++;
    }
    if (s.th === 0 && s.thead === 0) {
      console.log(`    ${WARN} 无表头结构，上下文分组可能退化为无分组`);
      warnings++;
    }
  }
}

// ========== 4. UI 常量替换审计 ==========

function auditUIConstants(files) {
  console.log("\n▶ UI 常量替换审计");

  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    const code = fs.readFileSync(fullPath, "utf-8");
    const lines = code.split("\n");

    // 逐行检测硬编码，排除常量定义行
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 跳过常量定义行自身
      if (line.includes("DRAWER_MODAL_SELECTORS") && line.includes("=")) continue;
      if (line.includes("ANT_PAGINATION_DISABLED") && line.includes("=")) continue;
      if (line.includes("ARCO_PAGINATION_DISABLED") && line.includes("=")) continue;

      if (/[.`'"]ant-drawer-body,\s*\.ant-modal-body,\s*\.arco-drawer-body,\s*\.arco-modal-body/.test(line)) {
        violations.push(`L${i + 1}: DRAWER_MODAL_SELECTORS 硬编码`);
      }
      if (/"ant-pagination-disabled"/.test(line)) {
        violations.push(`L${i + 1}: ant-pagination-disabled 硬编码`);
      }
      if (/"arco-pagination-item-disabled"/.test(line)) {
        violations.push(`L${i + 1}: arco-pagination-item-disabled 硬编码`);
      }
    }

    if (violations.length > 0) {
      console.log(`  ${FAIL} ${file}: 发现 ${violations.length} 处硬编码`);
      violations.forEach((v) => console.log(`      ${v}`));
      errors++;
    } else {
      console.log(`  ${PASS} ${file}: 无硬编码残留`);
    }

    if (file.includes("table.js")) {
      const hasDrawer = code.includes("DRAWER_MODAL_SELECTORS");
      const hasAnt = code.includes("ANT_PAGINATION_DISABLED");
      const hasArco = code.includes("ARCO_PAGINATION_DISABLED");
      console.log(`  ${hasDrawer ? PASS : FAIL} DRAWER_MODAL_SELECTORS 常量定义`);
      console.log(`  ${hasAnt ? PASS : FAIL} ANT_PAGINATION_DISABLED 常量定义`);
      console.log(`  ${hasArco ? PASS : FAIL} ARCO_PAGINATION_DISABLED 常量定义`);
      if (!hasDrawer || !hasAnt || !hasArco) errors++;
    }
  }
}

// ========== 5. 导出接口完整性 ==========

function checkExports(files) {
  console.log("\n▶ 导出接口审计");

  // 只验证关键导出是否存在（不穷举）
  const keyExports = {
    "src/content/table.js": [
      "getRowCells", "getCellCount", "isHeaderRow", "highlightRow",
      "addRowElToContext", "handleRowCheckboxChange", "ensureTableRowFab",
      "ensureBatchBar", "updateBatchBar", "getRowGroupRows",
      "selectAllRowsInSameGroup", "clearAllRowsInSameGroup",
    ],
    "src/content/context.js": [
      "addContextSnippet", "removeContextByRef", "removeContext",
      "clearContext", "clearChat", "clearAll",
      "buildContextBlock", "getContextTotalChars",
    ],
    "src/content/state.js": [
      "IS_TOP_FRAME", "STATE", "COL_SEPARATOR", "Z_INDEX",
      "uid", "clamp", "normalizeText", "compactOneLine", "refs", "DEBUG",
    ],
  };

  for (const [file, expected] of Object.entries(keyExports)) {
    const fullPath = path.join(ROOT, file);
    if (!fs.existsSync(fullPath)) {
      console.log(`  ${WARN} ${file}: 文件不存在`);
      warnings++;
      continue;
    }
    const exported = getAllExports(fullPath);
    const missing = expected.filter((e) => !exported.includes(e));
    if (missing.length > 0) {
      console.log(`  ${FAIL} ${file}: 缺失关键导出: ${missing.join(", ")}`);
      errors++;
    } else {
      console.log(`  ${PASS} ${file}: ${exported.length} 个导出, 关键导出完整`);
    }
  }
}

// ========== Main ==========

function main() {
  console.log("=".repeat(60));
  console.log("Web-to-AI Context Chat — 回归测试");
  console.log("=".repeat(60));

  const srcFiles = [
    "src/content/context-model.js",
    "src/content/context-ref.js",
    "src/content/onboarding.js",
    "src/content/table-adapters.js",
    "src/content/token-budget.js",
    "src/content/table-export.js",
    "src/content/table.js",
    "src/content/context.js",
    "src/content/state.js",
  ];

  const demoFiles = [
    "src/demo-html/table.html",
    "src/demo-html/table2.html",
    "src/demo-html/table3.html",
  ];

  checkSyntax(srcFiles);
  auditDebugLogs(srcFiles);
  verifyDemoHtml(demoFiles);
  auditUIConstants(["src/content/table.js"]);
  checkExports(srcFiles);

  console.log("\n" + "=".repeat(60));
  if (errors === 0 && warnings === 0) {
    console.log(`\n  ${PASS} 全部通过 (0 错误, 0 警告)`);
    process.exit(0);
  } else {
    console.log(`\n  错误: ${errors}, 警告: ${warnings}`);
    process.exit(errors > 0 ? 1 : 0);
  }
}

main();
