/**
 * @fileoverview 技能网页数据源的分页与虚拟滚动采集器。
 *
 * 采集完成语义、页数/行数上限和恢复第一页行为与旧实现一致。
 */

import { DEBUG, IS_TOP_FRAME, compactOneLine, uid } from "./state.js";
import { isVisibleElement } from "./dom.js";
import {
  MAX_SKILL_COLLECTION_PAGES, MAX_SKILL_COLLECTION_ROWS, classifyCollectionCompletion,
  classifyScrollCollection, nextVirtualScrollTop, shouldStopAfterNoProgress
} from "./skill-collection-model.js";
import {
  alignedRowCellTexts, extractHeaders, extractStoredSourceData, locateStoredSource
} from "./skill-source-dom.js";
import { getRowCells, isHeaderRow } from "./table-row-dom.js";
import {
  clickElement, findLiveTableAfterPageTurn, findPaginationNextButton, getTableContentDigest,
  getTableRowTexts, waitForTableChange, waitForTableDataReady
} from "./table-pagination-dom.js";

const activeCollections = new Map();
const SKILL_COLLECTION_DIAGNOSTICS = DEBUG;

// 普通跨页选择继续使用 table-pagination-dom 的保守默认值。技能采集已经先
// 校验数据源身份，可按内容摘要自适应结束等待，避免每次滚动/翻页固定停两秒。
const SKILL_VIRTUAL_READY_OPTIONS = Object.freeze({
  minWaitMs: 120,
  pollIntervalMs: 80,
  stableSamples: 2,
  compareContent: true,
  waitForLoading: true
});
const SKILL_PAGE_READY_OPTIONS = Object.freeze({
  minWaitMs: 300,
  pollIntervalMs: 100,
  stableSamples: 3,
  compareContent: true,
  waitForLoading: true
});

function emitCollectionProgress(collectionId, progress) {
  chrome.runtime.sendMessage({ type: "SKILL_COLLECTION_PROGRESS", collectionId, progress }).catch(() => void 0);
}

function logSkillCollection(event, details = {}) {
  if (!SKILL_COLLECTION_DIAGNOSTICS) return;
  SKILL_COLLECTION_DIAGNOSTICS && console.info("[web2ai.skill-collection]", event, JSON.stringify({
    frame: IS_TOP_FRAME ? "top" : "child",
    ...details
  }));
}

function describeCollectionElement(node) {
  if (!node) return "none";
  const id = node.id ? `#${node.id}` : "";
  const classes = String(node.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 4).join(".");
  return `${node.tagName?.toLowerCase?.() || "element"}${id}${classes ? `.${classes}` : ""}`;
}

function describeScrollCandidates(table) {
  if (!table) return [];
  const nodes = new Set();
  table.querySelectorAll?.([
    ".ant-table-body", ".ant-table-content", ".ant-virtual-list-holder",
    ".arco-table-body", ".arco-scrollbar-container", ".arco-virtual-list",
    ".art-table-body", ".art-virtual-scroll", "[class*='virtual-list']", "[class*='virtual-scroll']",
    "[role='rowgroup']"
  ].join(",")).forEach((node) => nodes.add(node));
  let ancestor = table;
  for (let depth = 0; depth < 10 && ancestor; depth++, ancestor = ancestor.parentElement) nodes.add(ancestor);
  // 同源 iframe 可能随内容自动增高，自身没有滚动范围，真正的 viewport 在父页面。
  // 诊断与选择逻辑都要沿 frameElement 向上查看父文档滚动器。
  try {
    for (let currentWindow = window; currentWindow !== currentWindow.parent;) {
      const parentWindow = currentWindow.parent;
      if (parentWindow.document?.scrollingElement) nodes.add(parentWindow.document.scrollingElement);
      currentWindow = parentWindow;
    }
  } catch { /* 跨域父 frame 不能直接访问，保留当前 frame 候选。 */ }
  return [...nodes].filter((node) => node?.nodeType === 1).slice(0, 16).map((node) => ({
    element: describeCollectionElement(node),
    clientHeight: Math.round(node.clientHeight || 0),
    scrollHeight: Math.round(node.scrollHeight || 0),
    scrollTop: Math.round(node.scrollTop || 0),
    overflowY: node.ownerDocument?.defaultView?.getComputedStyle(node)?.overflowY || "",
    visible: isVisibleCollectionElement(node)
  }));
}

function isVisibleCollectionElement(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.ownerDocument === document) return isVisibleElement(node);
  const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
  const rect = node.getBoundingClientRect?.();
  return Boolean(style && rect && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") !== 0 && rect.width >= 2 && rect.height >= 2);
}

function findStoredSourceVerticalScroller(table) {
  if (!table) return null;
  const row = table.querySelector?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
  const candidates = new Set();
  const knownSelectors = [
    ".ant-table-body", ".ant-table-content", ".ant-virtual-list-holder",
    ".arco-table-body", ".arco-scrollbar-container", ".arco-virtual-list",
    ".art-table-body", ".art-virtual-scroll", "[class*='virtual-list']", "[class*='virtual-scroll']",
    "[role='rowgroup']"
  ].join(",");
  table.querySelectorAll?.(knownSelectors).forEach((node) => candidates.add(node));
  let ancestor = row || table;
  for (let depth = 0; depth < 20 && ancestor; depth++, ancestor = ancestor.parentElement) candidates.add(ancestor);
  // 一些嵌入式业务页面使用 iframe 文档本身驱动虚拟表格渲染，表格祖先没有 overflow。
  if (document.scrollingElement) candidates.add(document.scrollingElement);
  try {
    for (let currentWindow = window; currentWindow !== currentWindow.parent;) {
      const parentWindow = currentWindow.parent;
      if (parentWindow.document?.scrollingElement) candidates.add(parentWindow.document.scrollingElement);
      currentWindow = parentWindow;
    }
  } catch { /* 跨域父 frame 由后续兼容层处理，当前版本不能直接驱动。 */ }
  const ranked = [...candidates].filter((node) => {
    if (node?.nodeType !== 1 || !node.isConnected) return false;
    if (node !== node.ownerDocument?.scrollingElement && !isVisibleCollectionElement(node)) return false;
    return node.clientHeight >= 40 && node.scrollHeight - node.clientHeight > 8;
  }).map((node) => {
    const className = String(node.className || "");
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    const known = /(ant-table-body|virtual-list-holder|arco-table-body|arco-scrollbar-container|virtual-list|virtual-scroll|art-table-body)/i.test(className);
    const scrollStyle = /(auto|scroll)/.test(style.overflowY || "");
    const containsRow = Boolean(row && node.contains(row));
    const documentScroller = node === node.ownerDocument?.scrollingElement;
    const ancestorFrameScroller = node.ownerDocument !== document;
    return { node, score: (known ? 8 : 0) + (scrollStyle ? 4 : 0) + (containsRow ? 3 : 0) + (ancestorFrameScroller ? 2 : 0) - (documentScroller ? 1 : 0) - Math.min(node.clientHeight / 1000, 2) };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.node || null;
}

function tableRectInDocument(table, targetDocument) {
  if (!table || !targetDocument) return null;
  let top = table.getBoundingClientRect().top;
  let height = table.getBoundingClientRect().height;
  try {
    for (let currentWindow = window; currentWindow.document !== targetDocument;) {
      const frame = currentWindow.frameElement;
      if (!frame || currentWindow === currentWindow.parent) return null;
      const frameRect = frame.getBoundingClientRect();
      top += frameRect.top;
      currentWindow = currentWindow.parent;
    }
  } catch { return null; }
  return { top, height };
}

function collectionScrollBounds(scroller, table) {
  const documentScroller = scroller === scroller?.ownerDocument?.scrollingElement;
  const isAncestorFrameScroller = scroller?.ownerDocument !== document;
  if (!documentScroller || !isAncestorFrameScroller) {
    return { start: 0, end: Math.max(0, scroller.scrollHeight - scroller.clientHeight), external: false };
  }
  const rect = tableRectInDocument(table, scroller.ownerDocument);
  if (!rect) return { start: scroller.scrollTop, end: Math.max(0, scroller.scrollHeight - scroller.clientHeight), external: true };
  const absoluteTop = scroller.scrollTop + rect.top;
  const maxDocumentTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const start = Math.max(0, Math.min(absoluteTop, maxDocumentTop));
  const end = Math.max(start, Math.min(absoluteTop + Math.max(0, rect.height - scroller.clientHeight), maxDocumentTop));
  return { start, end, external: true };
}

function setVerticalScrollTop(scroller, top) {
  const next = Math.max(0, Math.min(Number(top) || 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
  scroller.scrollTop = next;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  return scroller.scrollTop;
}

function classifyVerticalCollection(scroller, table) {
  const className = `${String(scroller?.className || "")} ${String(table?.className || "")}`;
  const renderedRows = Array.from(table?.querySelectorAll?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr") || [])
    .filter((row) => !isHeaderRow(row));
  const layoutNodes = [table, table?.parentElement, ...renderedRows.slice(0, 3)].filter(Boolean);
  const hasVirtualLayoutEvidence = layoutNodes.some((node) => {
    const style = getComputedStyle(node);
    const inlineTransform = String(node.style?.transform || "");
    return style.position === "absolute" || /translate(?:3d|Y)?\s*\(/i.test(inlineTransform);
  }) || Number(table?.getAttribute?.("aria-rowcount") || 0) > renderedRows.length;
  return classifyScrollCollection({
    className,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    renderedRowHeights: renderedRows.map((row) => row.getBoundingClientRect?.().height || 0),
    // 当前 frame 的长文档必须有虚拟布局证据；同源父 frame 的滚动器则只在
    // 当前 frame 完全无滚动范围时才会被选中，先以 probe 行为验证是否产生新行。
    isDocumentScroller: scroller === document.scrollingElement,
    hasVirtualLayoutEvidence
  });
}

function tableHasVirtualLayoutEvidence(table) {
  if (!table) return false;
  const renderedRows = Array.from(table.querySelectorAll?.(
    "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"
  ) || []).filter((row) => !isHeaderRow(row));
  const layoutNodes = [table, table.parentElement, ...renderedRows.slice(0, 3)].filter(Boolean);
  const virtualCss = /(art-table|virtual-list|virtual-scroll|virtualized)/i.test(`${table.className || ""} ${table.parentElement?.className || ""}`);
  const hasTransform = layoutNodes.some((node) => {
    const style = getComputedStyle(node);
    const inlineTransform = String(node.style?.transform || "");
    return style.position === "absolute" || /translate(?:3d|Y)?\s*\(/i.test(inlineTransform);
  });
  const ariaRowCount = Number(table.getAttribute?.("aria-rowcount") || 0);
  return Boolean(virtualCss || hasTransform || (ariaRowCount > 0 && ariaRowCount > renderedRows.length));
}

function safeScrollIntoView(target, block = "start") {
  if (!(target instanceof Element)) return false;
  try {
    // 当前 frame 内没有可操作的滚动容器时，依赖浏览器原生的 scroll 链式传播：
    // iframe 自动增高、真实 viewport 在祖先文档时，也能把表格滚到可视区域。
    target.scrollIntoView({ block, inline: "nearest" });
    return true;
  } catch {
    return false;
  }
}

async function waitForVirtualRows(source, beforeTable, beforeDigest, beforeRows) {
  await new Promise((resolve) => setTimeout(resolve, 60));
  const tableIndex = beforeTable?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(beforeTable) : -1;
  const changed = await waitForTableChange(beforeTable, beforeDigest, 2400, beforeRows, tableIndex);
  if (changed) {
    await waitForTableDataReady(
      findLiveTableAfterPageTurn(beforeTable, tableIndex), beforeDigest, 3000, tableIndex,
      SKILL_VIRTUAL_READY_OPTIONS
    );
  }
}

async function resolvePageScrollCollection(source, initialTable, page) {
  let table = initialTable;
  let scroller = findStoredSourceVerticalScroller(table);
  let mode = scroller ? classifyVerticalCollection(scroller, table) : "none";
  // 有些虚拟表格的真实滚动由祖先文档承载，当前 frame 看不到 scrollTop/scrollHeight。
  // 这类场景不能误判成普通表格直接翻页，而是改用 scrollIntoView 的保守采集模式。
  if (!scroller && tableHasVirtualLayoutEvidence(table)) mode = "into-view";
  // 分页切换完成不等于虚拟列表布局已完成。每一页都允许占位高度、
  // overflow 容器和首批行再经历几个渲染周期，否则后续页会被误判为
  // 普通表格并直接翻页。重试只读布局，不对普通表格产生滚动副作用。
  const attempts = 4;
  for (let attempt = 1; mode === "none" && attempt < attempts; attempt++) {
    logSkillCollection("scroll detection retry", {
      page,
      attempt,
      table: describeCollectionElement(table),
      scroller: describeCollectionElement(scroller),
      candidates: describeScrollCandidates(table)
    });
    await new Promise((resolve) => setTimeout(resolve, 140));
    table = findStoredSourceTable(source) || table;
    scroller = findStoredSourceVerticalScroller(table);
    mode = scroller ? classifyVerticalCollection(scroller, table) : (tableHasVirtualLayoutEvidence(table) ? "into-view" : "none");
  }
  logSkillCollection("scroll detection result", {
    page,
    mode,
    table: describeCollectionElement(table),
    scroller: describeCollectionElement(scroller),
    scrollTop: Math.round(scroller?.scrollTop || 0),
    clientHeight: Math.round(scroller?.clientHeight || 0),
    scrollHeight: Math.round(scroller?.scrollHeight || 0),
    candidates: describeScrollCandidates(table)
  });
  return { table, scroller, mode };
}

async function collectStoredSourcePage(source, { collectionId, control, page, maxPages, maxRows, rows, seen, waitForInitialRowsMs = 0 }) {
  let headers = [];
  let added = 0;
  let scrollSteps = 0;
  const addRenderedRows = () => {
    const current = extractStoredSourceData(source, maxRows);
    if (!current.found) return current;
    headers = current.headers || headers;
    for (const row of current.rows || []) {
      const signature = row.join("\u241f");
      if (seen.has(signature)) continue;
      seen.add(signature);
      rows.push(row);
      added++;
      if (rows.length >= maxRows) break;
    }
    return current;
  };

  // 分页与虚拟滚动叠加时，业务页可能保留上次的 scrollTop，或在换页后
  // 默认定位到中间。必须在第一次 addRenderedRows 之前回到顶部，否则被回收的
  // 顶部行永远不会进入 seen/rows，后续再复位也无法识别这个缺口。
  let table = findStoredSourceTable(source);
  let scroller = findStoredSourceVerticalScroller(table);
  let initialBounds = scroller ? collectionScrollBounds(scroller, table) : null;
  logSkillCollection("page prepare", {
    collectionId, page,
    table: describeCollectionElement(table),
    scroller: describeCollectionElement(scroller),
    scrollTop: Math.round(scroller?.scrollTop || 0),
    collectionStart: Math.round(initialBounds?.start || 0),
    collectionEnd: Math.round(initialBounds?.end || 0),
    externalScroller: Boolean(initialBounds?.external),
    clientHeight: Math.round(scroller?.clientHeight || 0),
    scrollHeight: Math.round(scroller?.scrollHeight || 0),
    candidates: describeScrollCandidates(table)
  });
  if (scroller?.isConnected) {
    if (Math.abs(scroller.scrollTop - initialBounds.start) > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, initialBounds.start);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      table = findStoredSourceTable(source) || table;
      scroller = findStoredSourceVerticalScroller(table) || scroller;
      logSkillCollection("prepare page top", {
        collectionId, page, success: Math.abs(scroller.scrollTop - initialBounds.start) <= 1,
        scrollTop: Math.round(scroller.scrollTop), targetTop: Math.round(initialBounds.start)
      });
    }
  } else if (table && tableHasVirtualLayoutEvidence(table)) {
    // 当前 frame 没有原生滚动容器时，也要先把视口对齐到表格顶部；否则首屏可能从
    // 中间开始渲染，顶部已回收的记录永远不会进入本页采集结果。
    const beforeDigest = getTableContentDigest(table);
    const beforeRows = getTableRowTexts(table);
    safeScrollIntoView(table, "start");
    await waitForVirtualRows(source, table, beforeDigest, beforeRows);
    table = findStoredSourceTable(source) || table;
    logSkillCollection("prepare page top", {
      collectionId, page, method: "into-view",
      success: true,
      table: describeCollectionElement(table)
    });
  }

  let current = addRenderedRows();
  logSkillCollection("first rendered rows", {
    collectionId, page, found: Boolean(current.found), renderedRows: current.rowCount || 0,
    added, totalRows: rows.length, scrollTop: Math.round(scroller?.scrollTop || 0)
  });
  if (!current.found) return { found: false, headers, added, scrollSteps };
  if (page === 1 && !current.rowCount && waitForInitialRowsMs > 0) {
    const startedAt = Date.now();
    while (!control.stopped && Date.now() - startedAt < waitForInitialRowsMs) {
      emitCollectionProgress(collectionId, {
        phase: "waiting-rows", page, pages: 0, rowCount: rows.length, maxPages, maxRows
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
      if (current.rowCount > 0) break;
    }
    logSkillCollection("initial rows ready", {
      collectionId, page, waitedMs: Date.now() - startedAt, renderedRows: current.rowCount || 0
    });
  }
  const scrollCollection = await resolvePageScrollCollection(source, table, page);
  table = scrollCollection.table;
  scroller = scrollCollection.scroller;
  const scrollMode = scrollCollection.mode;
  // 等待期间首屏可能继续补行，先收录再开始滚动。
  current = addRenderedRows();
  if (!current.found) return { found: false, headers, added, scrollSteps };
  logSkillCollection("page scan", {
    collectionId, page, table: describeCollectionElement(table), scroller: describeCollectionElement(scroller),
    scrollMode, renderedRows: current.rowCount || 0, added, totalRows: rows.length,
    scrollTop: Math.round(scroller?.scrollTop || 0), clientHeight: scroller?.clientHeight || 0,
    scrollHeight: scroller?.scrollHeight || 0,
    candidates: page === 1 ? describeScrollCandidates(table) : undefined
  });
  if (scrollMode === "none") {
    logSkillCollection("page scroll skipped", {
      collectionId, page, reason: "no-scroll-mode", renderedRows: current.rowCount || 0,
      added, totalRows: rows.length, candidates: describeScrollCandidates(table)
    });
    return { found: true, headers, added, scrollSteps };
  }

  try {
    if (scrollMode === "into-view") {
      let consecutiveEmptySteps = 0;
      let stableBottomPasses = 0;
      for (let step = 0; step < 160 && rows.length < maxRows && !control.stopped; step++) {
        table = findStoredSourceTable(source) || table;
        const renderedRowEls = Array.from(table?.querySelectorAll?.(
          "tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr"
        ) || []).filter((row) => !isHeaderRow(row));
        // 选择当前最后一个可见数据行作为锚点，驱动外层 viewport 继续向下；这样在
        // 当前 frame 无法直接控制 scrollTop 时，仍能逐步触发虚拟列表补渲染后续行。
        const anchor = renderedRowEls.filter((row) => isVisibleCollectionElement(row)).at(-1) || renderedRowEls.at(-1) || table;
        const beforeDigest = getTableContentDigest(table);
        const beforeRows = getTableRowTexts(table);
        const scrolled = safeScrollIntoView(anchor, "end");
        scrollSteps++;
        emitCollectionProgress(collectionId, {
          phase: "scrolling", page, pages: page - 1, rowCount: rows.length, scrollSteps,
          maxPages, maxRows
        });
        if (!scrolled) break;
        await waitForVirtualRows(source, table, beforeDigest, beforeRows);
        const addedBefore = added;
        current = addRenderedRows();
        if (!current.found) return { found: false, headers, added, scrollSteps };
        const newlyAdded = added - addedBefore;
        consecutiveEmptySteps = newlyAdded > 0 ? 0 : consecutiveEmptySteps + 1;
        logSkillCollection("scroll step", {
          collectionId, page, step: scrollSteps, mode: "into-view",
          renderedRows: current.rowCount || 0, added: newlyAdded, consecutiveEmptySteps, totalRows: rows.length
        });
        if (newlyAdded <= 0) stableBottomPasses++;
        else stableBottomPasses = 0;
        if (stableBottomPasses >= 2 || shouldStopAfterNoProgress(consecutiveEmptySteps, 2)) break;
      }
      logSkillCollection("page scroll complete", { collectionId, page, scrollSteps, added, totalRows: rows.length, stopped: control.stopped, mode: "into-view" });
      return { found: true, headers, added, scrollSteps, stopped: control.stopped };
    }

    let bounds = collectionScrollBounds(scroller, table);
    if (Math.abs(scroller.scrollTop - bounds.start) > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, bounds.start);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
    }

    let stableBottomPasses = 0;
    let consecutiveEmptySteps = 0;
    let scrollingConfirmed = scrollMode === "confirmed";
    for (let step = 0; step < 160 && rows.length < maxRows && !control.stopped; step++) {
      table = findStoredSourceTable(source);
      scroller = findStoredSourceVerticalScroller(table) || scroller;
      bounds = collectionScrollBounds(scroller, table);
      const maxScrollTop = bounds.end;
      const currentTop = scroller.scrollTop;
      if (currentTop >= maxScrollTop - 2) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const expandedMax = collectionScrollBounds(scroller, table).end;
        if (expandedMax <= currentTop + 2) {
          stableBottomPasses++;
          if (stableBottomPasses >= 2) break;
          continue;
        }
      }
      stableBottomPasses = 0;
      const nextTop = Math.min(maxScrollTop, nextVirtualScrollTop({
        scrollTop: currentTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      }));
      if (nextTop <= currentTop + 1) break;
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      const actualTop = setVerticalScrollTop(scroller, nextTop);
      scrollSteps++;
      emitCollectionProgress(collectionId, {
        phase: "scrolling", page, pages: page - 1, rowCount: rows.length, scrollSteps,
        scrollTop: Math.round(actualTop), maxScrollTop: Math.round(maxScrollTop),
        maxPages, maxRows
      });
      await waitForVirtualRows(source, table, beforeDigest, beforeRows);
      const addedBeforeScrollRead = added;
      current = addRenderedRows();
      if (!current.found) return { found: false, headers, added, scrollSteps };
      const newlyAdded = added - addedBeforeScrollRead;
      // `probe` 只表示初次缺少框架级虚拟滚动特征。一旦实际滚动获得了
      // 新数据，就已经用行为证明确实需要滚动；后续应容忍一个短暂空白
      // 区间，不能仍按“一次无新增即停止”的防误判规则提前结束。
      if (newlyAdded > 0) scrollingConfirmed = true;
      consecutiveEmptySteps = newlyAdded > 0 ? 0 : consecutiveEmptySteps + 1;
      logSkillCollection("scroll step", {
        collectionId, page, step: scrollSteps, targetTop: Math.round(nextTop), actualTop: Math.round(scroller.scrollTop),
        clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        renderedRows: current.rowCount || 0, added: newlyAdded, consecutiveEmptySteps, scrollingConfirmed, totalRows: rows.length
      });
      const emptyStepLimit = scrollingConfirmed ? 2 : 1;
      if (shouldStopAfterNoProgress(consecutiveEmptySteps, emptyStepLimit)) {
        logSkillCollection("page scroll stopped", {
          collectionId, page, reason: "no-new-rows", scrollSteps, consecutiveEmptySteps, totalRows: rows.length
        });
        break;
      }
    }
    logSkillCollection("page scroll complete", { collectionId, page, scrollSteps, added, totalRows: rows.length, stopped: control.stopped });
    return { found: true, headers, added, scrollSteps, stopped: control.stopped };
  } finally {
    table = findStoredSourceTable(source);
    scroller = findStoredSourceVerticalScroller(table) || scroller;
    const restoreBounds = scroller?.isConnected ? collectionScrollBounds(scroller, table) : null;
    if (scroller?.isConnected && Math.abs(scroller.scrollTop - restoreBounds.start) > 1) {
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      setVerticalScrollTop(scroller, restoreBounds.start);
      await waitForVirtualRows(source, table, beforeDigest, beforeRows).catch(() => void 0);
      logSkillCollection("restore table top", {
        collectionId, page, success: Math.abs(scroller.scrollTop - restoreBounds.start) <= 1,
        scrollTop: Math.round(scroller.scrollTop), targetTop: Math.round(restoreBounds.start)
      });
    }
  }
}

function findStoredSourcePagination(table) {
  let scope = table;
  for (let depth = 0; depth < 9 && scope; depth++, scope = scope.parentElement) {
    const candidates = Array.from(scope.querySelectorAll?.(".ant-pagination,.arco-pagination,[class*='pagination'],[role='navigation']") || []);
    const pagination = candidates.find((candidate) => {
      const text = compactOneLine(candidate.innerText || candidate.textContent || "");
      return /(^|\s)1(\s|$)/.test(text) || candidate.querySelector("[aria-current='page'],.ant-pagination-item-active,.arco-pagination-item-active");
    });
    if (pagination) return pagination;
  }
  return null;
}

function paginationIsOnFirstPage(pagination) {
  const active = pagination?.querySelector?.("[aria-current='page'],.ant-pagination-item-active,.arco-pagination-item-active");
  return compactOneLine(active?.innerText || active?.textContent || "") === "1";
}

async function restoreStoredSourceTableTop(source, reason = "restore") {
  const table = findStoredSourceTable(source);
  const scroller = findStoredSourceVerticalScroller(table);
  if (!scroller?.isConnected) return true;
  const bounds = collectionScrollBounds(scroller, table);
  if (Math.abs(scroller.scrollTop - bounds.start) <= 1) return true;
  const beforeDigest = getTableContentDigest(table);
  const beforeRows = getTableRowTexts(table);
  setVerticalScrollTop(scroller, bounds.start);
  await waitForVirtualRows(source, table, beforeDigest, beforeRows).catch(() => void 0);
  const liveTable = findStoredSourceTable(source) || table;
  const liveScroller = findStoredSourceVerticalScroller(liveTable) || scroller;
  const liveBounds = collectionScrollBounds(liveScroller, liveTable);
  const success = Math.abs(liveScroller.scrollTop - liveBounds.start) <= 1;
  logSkillCollection("restore table top", {
    reason, success, scrollTop: Math.round(liveScroller.scrollTop), targetTop: Math.round(liveBounds.start)
  });
  return success;
}

async function clickPaginationAndWait(source, target) {
  const table = findStoredSourceTable(source);
  if (!table || !target) return false;
  const beforeRows = getTableRowTexts(table);
  const beforeDigest = getTableContentDigest(table);
  const tableIndex = table?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(table) : -1;
  if (!clickElement(target)) return false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const changed = await waitForTableChange(table, beforeDigest, 6000, beforeRows, tableIndex);
  if (!changed) return false;
  await waitForTableDataReady(
    findLiveTableAfterPageTurn(table, tableIndex), beforeDigest, 6000, tableIndex,
    SKILL_PAGE_READY_OPTIONS
  );
  return true;
}

async function restoreStoredSourceFirstPage(source) {
  let table = findStoredSourceTable(source);
  let pagination = findStoredSourcePagination(table);
  if (!pagination) {
    logSkillCollection("restore first page", { success: false, reason: "pagination-not-found" });
    return false;
  }
  if (paginationIsOnFirstPage(pagination)) {
    await restoreStoredSourceTableTop(source, "already-first-page");
    logSkillCollection("restore first page", { success: true, method: "already-first" });
    return true;
  }

  const pageOneContainer = Array.from(pagination.querySelectorAll("li,button,a,[role='button']"))
    .find((node) => compactOneLine(node.innerText || node.textContent || "") === "1");
  const pageOne = pageOneContainer?.matches?.("button,a,[role='button']")
    ? pageOneContainer
    : pageOneContainer?.querySelector?.("button,a,[role='button']") || pageOneContainer;
  if (pageOne && await clickPaginationAndWait(source, pageOne)) {
    table = findStoredSourceTable(source);
    pagination = findStoredSourcePagination(table);
    if (paginationIsOnFirstPage(pagination)) {
      await restoreStoredSourceTableTop(source, "page-one-button");
      logSkillCollection("restore first page", { success: true, method: "page-button" });
      return true;
    }
  }

  // 部分页码组件会折叠第一页，或只能通过“上一页”逐页返回。
  for (let attempt = 0; attempt < 20; attempt++) {
    table = findStoredSourceTable(source);
    pagination = findStoredSourcePagination(table);
    if (!pagination || paginationIsOnFirstPage(pagination)) {
      if (pagination) await restoreStoredSourceTableTop(source, "previous-buttons");
      return Boolean(pagination);
    }
    const previous = pagination.querySelector(
      ".ant-pagination-prev button,.ant-pagination-prev a,.ant-pagination-prev .ant-pagination-item-link," +
      ".arco-pagination-item-previous button,.arco-pagination-prev button," +
      "button[aria-label*='上一页'],a[aria-label*='上一页'],button[aria-label*='previous' i],a[aria-label*='previous' i]"
    );
    const previousContainer = previous?.closest?.(".ant-pagination-prev,.arco-pagination-item-previous,.arco-pagination-prev");
    const disabled = !previous || previous.disabled || previous.getAttribute?.("aria-disabled") === "true" ||
      previousContainer?.classList?.contains("ant-pagination-disabled") ||
      previousContainer?.classList?.contains("arco-pagination-item-disabled");
    if (disabled || !await clickPaginationAndWait(source, previous)) break;
  }
  table = findStoredSourceTable(source);
  const restored = paginationIsOnFirstPage(findStoredSourcePagination(table));
  if (restored) await restoreStoredSourceTableTop(source, "previous-buttons-complete");
  logSkillCollection("restore first page", { success: restored, method: "previous-buttons", reason: restored ? "" : "page-change-not-confirmed" });
  return restored;
}

async function collectStoredSourceData(source, options = {}) {
  const collectionId = String(options.collectionId || uid());
  const maxPages = Math.max(1, Math.min(MAX_SKILL_COLLECTION_PAGES, Number(options.maxPages) || 1));
  const maxRows = Math.max(1, Math.min(MAX_SKILL_COLLECTION_ROWS, Number(options.maxRows) || MAX_SKILL_COLLECTION_ROWS));
  const control = { stopped: false };
  activeCollections.set(collectionId, control);
  const rows = [];
  const seen = new Set();
  let headers = [];
  let pages = 0;
  let reason = "complete";
  let pageTurned = false;
  let restoredFirstPage = false;
  logSkillCollection("start", { collectionId, maxPages, maxRows });
  try {
    for (let page = 1; page <= maxPages; page++) {
      if (control.stopped) { reason = "stopped"; break; }
      logSkillCollection("page start", { collectionId, page, totalRows: rows.length });
      emitCollectionProgress(collectionId, { phase: "reading", page, pages, rowCount: rows.length, maxPages, maxRows });
      const currentPage = await collectStoredSourcePage(source, {
        collectionId, control, page, maxPages, maxRows, rows, seen,
        waitForInitialRowsMs: Number(options.waitForInitialRowsMs) || 0
      });
      if (!currentPage.found) throw new Error("数据源定位失败");
      headers = currentPage.headers || headers;
      pages = page;
      emitCollectionProgress(collectionId, {
        phase: "page-complete", page, pages, rowCount: rows.length,
        added: currentPage.added, scrollSteps: currentPage.scrollSteps, maxPages, maxRows
      });
      logSkillCollection("page complete", {
        collectionId, page, added: currentPage.added, scrollSteps: currentPage.scrollSteps,
        totalRows: rows.length, stopped: control.stopped
      });
      if (control.stopped) { reason = "stopped"; break; }
      if (rows.length >= maxRows) { reason = "row-limit"; break; }
      if (page >= maxPages) { reason = "page-limit"; break; }
      const table = findStoredSourceTable(source);
      const anchorRow = table?.querySelector?.("tbody tr, [role='row'], .art-table-row, .ant-table-row, .arco-table-tr");
      const next = findPaginationNextButton(anchorRow);
      const pagination = next?.closest?.(".ant-pagination,.arco-pagination,[class*='pagination'],[role='navigation']");
      const nextContainer = next?.closest?.(".ant-pagination-next,.arco-pagination-item-next,.arco-pagination-next");
      const disabled = !next || next.disabled || next.getAttribute?.("aria-disabled") === "true" ||
        nextContainer?.classList?.contains("ant-pagination-disabled") ||
        nextContainer?.classList?.contains("arco-pagination-item-disabled");
      logSkillCollection("pagination next", {
        collectionId, page, next: describeCollectionElement(next), pagination: describeCollectionElement(pagination), disabled
      });
      if (disabled) { reason = "last-page"; break; }
      const beforeDigest = getTableContentDigest(table);
      const beforeRows = getTableRowTexts(table);
      const tableIndex = table?.tagName === "TABLE" ? Array.from(document.querySelectorAll("table")).indexOf(table) : -1;
      emitCollectionProgress(collectionId, { phase: "turning", page, pages, rowCount: rows.length, maxPages, maxRows });
      if (!clickElement(next)) { reason = "next-click-failed"; break; }
      pageTurned = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (control.stopped) { reason = "stopped"; break; }
      const changed = await waitForTableChange(table, beforeDigest, 8000, beforeRows, tableIndex);
      if (!changed) {
        logSkillCollection("page turn", { collectionId, page, success: false, reason: "table-not-changed" });
        reason = "page-timeout";
        break;
      }
      const ready = await waitForTableDataReady(
        findLiveTableAfterPageTurn(table, tableIndex), beforeDigest, 8000, tableIndex,
        SKILL_PAGE_READY_OPTIONS
      );
      const turnedTable = findStoredSourceTable(source);
      logSkillCollection("page turn", {
        collectionId, page, success: ready, reason: ready ? "" : "table-not-ready",
        nextTable: describeCollectionElement(turnedTable),
        candidates: describeScrollCandidates(turnedTable)
      });
      if (!ready) { reason = "page-timeout"; break; }
    }
    if (pageTurned) {
      emitCollectionProgress(collectionId, { phase: "restoring", pages, rowCount: rows.length, maxPages, maxRows });
      restoredFirstPage = await restoreStoredSourceFirstPage(source);
    }
    emitCollectionProgress(collectionId, { phase: "complete", pages, rowCount: rows.length, maxPages, maxRows, reason });
    logSkillCollection("complete", { collectionId, pages, rowCount: rows.length, uniqueSignatures: seen.size, reason, restoredFirstPage });
    const completion = classifyCollectionCompletion(reason);
    return {
      found: true, status: "available", headers, rows, rowCount: rows.length,
      totalRowCount: rows.length, collectedPages: pages, collectionReason: reason,
      ...completion,
      stopped: reason === "stopped", truncated: reason === "row-limit" || reason === "page-limit"
    };
  } finally {
    if (pageTurned && !restoredFirstPage) {
      emitCollectionProgress(collectionId, { phase: "restoring", pages, rowCount: rows.length, maxPages, maxRows });
      await restoreStoredSourceFirstPage(source).catch(() => false);
    }
    activeCollections.delete(collectionId);
  }
}

function stopStoredSourceCollection(collectionId) {
  const control = activeCollections.get(String(collectionId || ""));
  if (!control) return false;
  control.stopped = true;
  return true;
}

function findStoredSourceTable(source) {
  return locateStoredSource(source).table;
}


export {
  collectStoredSourceData, stopStoredSourceCollection, findStoredSourceTable
};
