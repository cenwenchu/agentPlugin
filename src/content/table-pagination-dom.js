/**
 * @fileoverview 表格分页器识别和页面变化等待工具。
 *
 * 只负责 DOM 定位、点击和稳定性检测；跨页选择的业务状态仍由 table.js 管理。
 */

import { DEBUG, compactOneLine, refs } from "./state.js";
import { isVisibleElement } from "./dom.js";
import { getBusinessRowText, getRowCells } from "./table-row-dom.js";

const DRAWER_MODAL_SELECTORS = ".ant-drawer-body, .ant-modal-body, .arco-drawer-body, .arco-modal-body";
const ANT_PAGINATION_DISABLED = "ant-pagination-disabled";
const ARCO_PAGINATION_DISABLED = "arco-pagination-item-disabled";
const VXE_PAGER_DISABLED = "is--disabled";

function getTableRootForRow(rowEl) {
  if (!rowEl) return null;
  // 通用：沿 DOM 树向上找最近的有表格语义的容器
  const candidates = [
    rowEl.closest("table"),
    rowEl.closest("tbody"),
    rowEl.closest("thead"),
    rowEl.closest("tfoot"),
    rowEl.closest('[role="grid"]'),
    rowEl.closest('[role="table"]'),
    rowEl.closest('[role="treegrid"]'),
    rowEl.closest('[role="rowgroup"]'),
  ].filter(Boolean);
  // 返回最近的（最内层的）
  let best = null;
  for (const c of candidates) {
    if (!best || c.contains(best)) best = c;
  }
  return best || rowEl.parentElement || rowEl;
}

function getTableRowCount(root) {
  if (!root) return 0;
  const rows = root.querySelectorAll?.("tbody tr, tr, thead tr, tfoot tr, [role='rowgroup'] [role='row'], [role='row']") || [];
  let count = 0;
  for (const r of rows) {
    if (!r.isConnected) continue;
    const cells = getRowCells(r);
    if (cells.length) count++;
  }
  return count;
}

function dumpAllTables(label) {
  const allTables = document.querySelectorAll("table");
  DEBUG && console.log(`[web2ai] ${label}: total tables in document: ${allTables.length}`);
  allTables.forEach((tbl, idx) => {
    const visible = isVisibleElement(tbl);
    const rect = tbl.getBoundingClientRect();
    const rows = tbl.querySelectorAll("tbody tr, tr");
    const rowTexts = Array.from(rows)
      .filter((row) => getRowCells(row).length > 0)
      .map((r, i) => {
        const raw = compactOneLine(getBusinessRowText(r, { separator: " ", emptyPlaceholder: "" })).slice(0, 50);
        return `[${i}] ${raw}`;
      });
    DEBUG && console.log(`[web2ai]   table[${idx}]: tag=${tbl.tagName} connected=${tbl.isConnected} visible=${visible} rect=${JSON.stringify({w:Math.round(rect.width),h:Math.round(rect.height)})} rows=${rowTexts.length}`);
    rowTexts.forEach(t => DEBUG && console.log(`[web2ai]     ${t}`));
  });
}

function waitForTableChange(root, prevDigest, timeoutMs = 8000, prevRowTexts, tableIndex) {
  return new Promise((resolve) => {
    const start = Date.now();
    dumpAllTables("waitForTableChange BEFORE");
    const prevTexts = prevRowTexts || getTableRowTexts(root);
    let settled = false;
    const observerTarget = refs.batchContainer?.isConnected ? refs.batchContainer : document.body;
    const finish = (changed) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(fallbackTimer);
      clearTimeout(timeoutTimer);
      if (changed) dumpAllTables("waitForTableChange CHANGED");
      resolve(changed);
    };
    const check = () => {
      if (settled) return;
      const elapsed = Date.now() - start;
      const liveRoot = (root && root.isConnected) ? root : findLiveTableByIndex(root, tableIndex);
      const currentRowTexts = getTableRowTexts(liveRoot);
      const rows = currentRowTexts.length;
      const contentChanged = prevTexts.length > 0 && currentRowTexts.length > 0 && (
        prevTexts.length !== currentRowTexts.length ||
        !prevTexts.every((t, i) => t === currentRowTexts[i])
      );
      DEBUG && console.log(`[web2ai] waitForTableChange check: root connected=${root?.isConnected} liveRoot=${liveRoot === root ? "original" : "recovered"} rows=${rows} contentChanged=${contentChanged} elapsed=${elapsed}ms`);
      if (contentChanged) finish(true);
    };
    const observer = new MutationObserver(() => check());
    observer.observe(observerTarget, { childList: true, subtree: true, characterData: true });
    // Some frameworks mutate canvas/internal state without useful records; keep a low-frequency fallback.
    const fallbackTimer = setInterval(check, 1000);
    const timeoutTimer = setTimeout(() => {
      dumpAllTables("waitForTableChange TIMEOUT");
      finish(false);
    }, timeoutMs);
    check();
  });
}

function findLiveTableByIndex(fallbackRoot, tableIndex) {
  if (tableIndex !== undefined && tableIndex >= 0) {
    const tables = document.querySelectorAll("table");
    const target = tables[tableIndex];
    if (target && target.isConnected && getTableRowCount(target) > 0) {
      return target;
    }
  }

  if (refs.batchContainer && refs.batchContainer.isConnected && tableIndex !== undefined && tableIndex >= 0) {
    const tablesInContainer = refs.batchContainer.querySelectorAll("table");
    const target = tablesInContainer[tableIndex];
    if (target && target.isConnected && getTableRowCount(target) > 0) {
      return target;
    }
  }

  if (refs.batchContainer && refs.batchContainer.isConnected) {
    let bestTable = null;
    let bestScore = -1;
    for (const tbl of refs.batchContainer.querySelectorAll("table")) {
      if (!tbl.isConnected) continue;
      if (!isVisibleElement(tbl)) continue;
      const rows = getTableRowCount(tbl);
      if (rows > bestScore) {
        bestScore = rows;
        bestTable = tbl;
      }
    }
    if (bestTable) return bestTable;
  }

  return fallbackRoot;
}

function getTableRowTexts(root) {
  if (!root) return [];
  const rows = root.querySelectorAll?.("tbody tr, tr, [role='rowgroup'] [role='row'], [role='row']") || [];
  const texts = [];
  for (const r of rows) {
    if (!getRowCells(r).length) continue;
    const raw = compactOneLine(getBusinessRowText(r, { separator: " ", emptyPlaceholder: "" }));
    const stripped = raw.replace(/^\d+\s*[✓✗]?\s*\|?\s*/, "").replace(/\s+/g, "").slice(0, 30);
    if (!stripped) continue;
    texts.push(stripped);
  }
  return texts;
}

function getTableContentDigest(root) {
  if (!root) return "";
  const texts = getTableRowTexts(root);
  const count = texts.length;
  const parts = texts.slice(0, 3);
  return `${count}|${parts.join("||")}`;
}

/**
 * 等待翻页或虚拟滚动后的表格进入稳定状态。
 *
 * 默认参数保留 table.js 原有的保守等待；技能采集器可传入更短的轮询周期，
 * 并启用整页可见内容摘要比较。快速页面无需固定等待两秒，慢页面仍会在
 * 内容持续变化或 loading 未结束时继续等待到稳定或硬超时。
 */
function waitForTableDataReady(root, prevDigest, timeoutMs = 12000, tableIndex, options = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastRows = -1;
    let lastContentDigest = "";
    let stableCount = 0;
    const minWaitMs = Math.max(0, Number(options.minWaitMs ?? 2000) || 0);
    const pollIntervalMs = Math.max(20, Number(options.pollIntervalMs ?? 400) || 400);
    const stableSamples = Math.max(1, Number(options.stableSamples ?? 3) || 3);
    const compareContent = Boolean(options.compareContent);
    const waitForLoading = Boolean(options.waitForLoading);
    const loadingSelector = ".ant-spin-spinning,.arco-spin-loading,[aria-busy='true']";

    const tableIsLoading = (liveRoot) => {
      if (!waitForLoading || !liveRoot) return false;
      let scope = liveRoot;
      for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
        if (scope.matches?.(loadingSelector) || scope.querySelector?.(loadingSelector)) return true;
      }
      return false;
    };

    const timer = setInterval(() => {
      const elapsed = Date.now() - start;

      const liveRoot = (root && root.isConnected) ? root : findLiveTableByIndex(root, tableIndex);
      const rows = getTableRowCount(liveRoot);
      const contentDigest = compareContent ? getTableRowTexts(liveRoot).join("\u241e") : "";
      const loading = tableIsLoading(liveRoot);

      DEBUG && console.log(`[web2ai] waitForTableDataReady rows=${rows} stableCount=${stableCount} loading=${loading} elapsed=${elapsed}ms root connected=${root?.isConnected} liveRoot=${liveRoot === root ? "original" : "recovered"}`);

      const contentStable = !compareContent || contentDigest === lastContentDigest;
      if (!loading && rows > 0 && rows === lastRows && contentStable) {
        stableCount++;
        if (stableCount >= stableSamples && elapsed >= minWaitMs) {
          clearInterval(timer);
          DEBUG && console.log(`[web2ai] waitForTableDataReady resolved: ${rows} rows stable`);
          resolve(rows);
        }
      } else {
        stableCount = 0;
      }
      lastRows = rows;
      lastContentDigest = contentDigest;
      if (elapsed >= timeoutMs) {
        clearInterval(timer);
        DEBUG && console.log(`[web2ai] waitForTableDataReady TIMEOUT - returning ${rows} rows`);
        resolve(rows);
      }
    }, pollIntervalMs);
  });
}

function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView?.({ block: "center", inline: "center" });
  } catch {
    void 0;
  }
  try {
    el.focus?.();
  } catch {
    void 0;
  }
  try {
    // 分页器、抽屉按钮等站点控件经常同时监听 pointer/mouse/click。这里必须
    // 保证“只触发一次激活”，否则一次翻页可能被站点处理两次，出现跳页。
    el.click?.();
    return true;
  } catch {
    void 0;
  }
  try {
    const r = el.getBoundingClientRect?.();
    const pt = !r
      ? { x: 0, y: 0 }
      : { x: r.left + Math.min(10, Math.max(1, r.width / 2)), y: r.top + Math.min(10, Math.max(1, r.height / 2)) };
    el.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: pt.x,
      clientY: pt.y
    }));
    return true;
  } catch {
    void 0;
  }
  return false;
}

function findPaginationNextButton(anchorRowEl) {
  const start = anchorRowEl?.closest?.("table") || anchorRowEl?.closest?.("tbody") || anchorRowEl;
  const drawerContainer =
    anchorRowEl?.closest?.(DRAWER_MODAL_SELECTORS) ||
    anchorRowEl?.closest?.('[class*="drawer"i] [class*="body"i]') ||
    anchorRowEl?.closest?.('[class*="modal"i] [class*="body"i]');
  let p = start;
  for (let i = 0; i < 7 && p; i++) {
    const ant =
      p.querySelector?.(`.ant-pagination-next:not(.${ANT_PAGINATION_DISABLED}) button`) ||
      p.querySelector?.(`.ant-pagination-next:not(.${ANT_PAGINATION_DISABLED}) a`) ||
      p.querySelector?.(`.ant-pagination-next:not(.${ANT_PAGINATION_DISABLED}) .ant-pagination-item-link`) ||
      p.querySelector?.(`.ant-pagination-next button:not([disabled])`) ||
      p.querySelector?.(`.ant-pagination-next a`);
    if (ant && (!drawerContainer || drawerContainer.contains(ant))) return ant;
    const arco =
      p.querySelector?.(`.arco-pagination-item-next:not(.${ARCO_PAGINATION_DISABLED}) button`) ||
      p.querySelector?.(`.arco-pagination-item-next:not(.${ARCO_PAGINATION_DISABLED}) a`) ||
      p.querySelector?.(`.arco-pagination-next:not(.${ARCO_PAGINATION_DISABLED}) button`);
    if (arco && (!drawerContainer || drawerContainer.contains(arco))) return arco;
    const vxe =
      p.querySelector?.(`.vxe-pager--next-btn:not(.${VXE_PAGER_DISABLED})`) ||
      p.querySelector?.(`.vxe-pager .btn-next:not(.${VXE_PAGER_DISABLED})`);
    if (vxe && (!drawerContainer || drawerContainer.contains(vxe))) return vxe;
    const ariaNext =
      p.querySelector?.(
        "button[aria-label*='下一页']:not([disabled]):not([aria-disabled='true']),a[aria-label*='下一页']"
      ) ||
      p.querySelector?.(
        "button[aria-label*='next']:not([disabled]):not([aria-disabled='true']),a[aria-label*='next']"
      );
    if (ariaNext && (!drawerContainer || drawerContainer.contains(ariaNext))) return ariaNext;
    const nav = p.querySelector?.("[class*='pagination'],[class*='pager'],[role='navigation']");
    if (nav) {
      const btns = Array.from(nav.querySelectorAll("button,a")).filter((x) => x && isVisibleElement(x));
      const pick = btns.find((b) => {
        const t = compactOneLine(b.innerText || b.textContent || "");
        if (!t) return false;
        return t === "下一页" || t === "Next" || t === "›" || t === ">";
      });
      if (pick && (!drawerContainer || drawerContainer.contains(pick))) return pick;
    }
    p = p.parentElement;
  }

  const scope = drawerContainer || document;
  const all = Array.from(scope.querySelectorAll("button,a,[role='button']")).filter(
    (x) => x && isVisibleElement(x)
  );
  const byText =
    all.find((b) => compactOneLine(b.innerText || b.textContent || "") === "下一页") ||
    all.find((b) => compactOneLine(b.innerText || b.textContent || "") === "Next");
  if (byText) return byText;
  const byAria = all.find((b) => {
    const aria = compactOneLine(b.getAttribute?.("aria-label") || "");
    const title = compactOneLine(b.getAttribute?.("title") || "");
    return (
      aria.includes("下一页") ||
      title.includes("下一页") ||
      aria.toLowerCase().includes("next") ||
      title.toLowerCase().includes("next")
    );
  });
  if (byAria) return byAria;

  const iconNext = all.find((b) => {
    if (b.classList.contains(ANT_PAGINATION_DISABLED)) return false;
    const icon = b.querySelector?.(".anticon-right, .anticon-next, svg[data-icon='right']");
    if (!icon) return false;
    const parent = b.closest?.(".ant-pagination-next, .ant-pagination-item-next");
    return !!parent;
  });
  if (iconNext) return iconNext;

  const anyNext = all.find((b) => {
    if (b.classList.contains(ANT_PAGINATION_DISABLED)) return false;
    const parent = b.closest?.(".ant-pagination-next, .ant-pagination-item-next");
    return !!parent;
  });
  if (anyNext) return anyNext;

  const iconBtn = all.find((b) => {
    if (b.classList.contains(ANT_PAGINATION_DISABLED)) return false;
    if (b.getAttribute("aria-disabled") === "true") return false;
    const icon = b.querySelector?.(".anticon-right, svg[data-icon='right']");
    return !!icon;
  });
  return iconBtn || null;
}

function pickFirstRowInRoot(root) {
  if (!root) return null;
  const tr = root.querySelector?.("tbody tr") || root.querySelector?.("tr");
  if (tr) return tr;
  const roleRow = root.querySelector?.('[role="rowgroup"] [role="row"]') || root.querySelector?.('[role="row"]');
  return roleRow || null;
}

function findLiveTableAfterPageTurn(root, tableIndex) {
  if (!root) return root;
  if (root.isConnected && getTableRowCount(root) > 0) return root;
  const recovered = findLiveTableByIndex(root, tableIndex);
  if (recovered !== root) {
    DEBUG && console.log(`[web2ai] findLiveTableAfterPageTurn recovered via tableIndex=${tableIndex}`);
  }
  return recovered;
}


export {
  DRAWER_MODAL_SELECTORS, ANT_PAGINATION_DISABLED, ARCO_PAGINATION_DISABLED,
  getTableRootForRow, getTableRowCount, dumpAllTables, waitForTableChange,
  findLiveTableByIndex, getTableRowTexts, getTableContentDigest, waitForTableDataReady,
  clickElement, findPaginationNextButton, pickFirstRowInRoot, findLiveTableAfterPageTurn
};
