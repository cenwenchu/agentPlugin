import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scenarios = [
  ["main extension workflow", "tests/e2e/chrome-extension.mjs"],
  ["business-tab source status", "tests/e2e/business-tab-source-status.mjs"],
  ["jtv1 tab skill grouping", "tests/e2e/jtv1-tab-skill-grouping.mjs"],
  ["jtv1 table recognition", "tests/e2e/jtv1-table-recognition.mjs"],
  ["multi-table source fallback", "tests/e2e/multi-table-source-fallback.mjs"]
];

function runScenario(name, file) {
  console.log(`\n[e2e:all] START ${name}`);
  return new Promise((resolve, reject) => {
    // 不经过 shell，保证 macOS/Linux/Windows 都能复用同一个完整测试入口。
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        console.log(`[e2e:all] PASS ${name}`);
        resolve();
        return;
      }
      reject(new Error(`${name} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

for (const [name, file] of scenarios) {
  await runScenario(name, file);
}

console.log(`\n[e2e:all] PASS ${scenarios.length} scenarios`);
