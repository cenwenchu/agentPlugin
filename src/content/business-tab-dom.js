/**
 * @fileoverview 业务页签（多标签 SPA 框架内的功能页签）DOM 识别、jtv1 判定与直达 URL。
 *
 * 背景：jtv1（聚水潭 epaas，erp321.com/epaas）这类框架把所有业务页签内嵌在
 * iframe 里，顶层 URL 不随业务切换变化，业务区分依赖"业务页签"而非地址栏。
 * 不同框架的页签 DOM 不同：
 *   - realTab：老框架，元素 class 以 `-realTab` 结尾（含 sc.scm121.com 分销版）
 *   - ant Tabs：聚水潭 epaas，标准 ant-design Tabs（.ant-tabs-tab-btn + aria-selected）
 *
 * 这里统一两套识别，ant Tabs 分支仅在页面呈现聚水潭特征（isJtv1LikePage）时
 * 启用，不影响只含 realTab 的旧框架页面，也不影响普通单页站点。
 *
 * 导出三块能力：
 *   - isJtv1LikePage：判定当前页是否 jtv1 框架（URL 路径 /epaas 优先，DOM 特征
 *     #_jt / .aspx iframe / epaas-tab- 页签 iframe 兜底）。DOM 判定不限域名，
 *     聚水潭系其他产品复用 #_jt 组件时也可能命中。
 *   - findBusinessTabElements / businessTabTitle / businessTabActive /
 *     closestBusinessTab：页签元素枚举、标题与激活态读取、事件目标回溯。
 *   - jtv1TabDirectUrl：生成 ?n=页签标题 直达 URL（仅 /epaas 路径有意义；?n=
 *     不影响 pageKey 匹配，用于直达与已关闭页签的重开）。
 */

import { compactOneLine } from "./state.js";

// 聚水潭 epaas 页面特征：业务 iframe src 为 app/.../*.aspx 形态，
// 或页签 iframe id 为 epaas-tab-*（欢迎页签 epaas-tab-welcome-page 常驻）
const JTV1_PAGE_SELECTOR = "#_jt, iframe[src*='.aspx'], iframe[id^='epaas-tab-']";

// 聚水潭 ant Tabs 的可点击页签按钮（含标题文本与 aria-selected 激活态）
const ANT_TAB_SELECTOR = ".ant-tabs-tab-btn, [role='tab'][aria-controls]";

function isJtv1LikePage() {
  // 1. URL 路径即 /epaas：整个框架（含首页）都是 jtv1，最稳的判定
  try {
    const path = (typeof location !== "undefined" ? location : document?.location)?.pathname || "";
    if (/^\/epaas\/?$/.test(path)) return true;
  } catch { /* ignore */ }
  // 2. DOM 特征：业务表格 / aspx iframe / epaas-tab 页签 iframe
  return Boolean(document.querySelector(JTV1_PAGE_SELECTOR));
}

function isRealTabElement(element) {
  return String(element?.className || "").split(/\s+/).some((name) => name.endsWith("-realTab"));
}

function antTabTitle(element) {
  // ant Tabs 的可点击按钮内部可能含图标/关闭按钮，标题通常在专门子节点或首尾文本
  const titleNode = element.querySelector?.(".ant-tabs-tab-btn, [class*='title']") || element;
  return compactOneLine(titleNode?.textContent ?? element.textContent ?? "");
}

/**
 * 读取当前页面的业务页签元素列表（统一 realTab 与聚水潭 ant Tabs）。
 * 返回元素数组，每个元素可通过 elementTitle() 取标题、elementActive() 取激活态。
 */
function findBusinessTabElements() {
  const realTabs = Array.from(document.querySelectorAll('[class*="realTab"]')).filter(isRealTabElement);
  if (realTabs.length) return realTabs.map((element) => ({ kind: "realTab", element }));
  if (!isJtv1LikePage()) return [];
  return Array.from(document.querySelectorAll(ANT_TAB_SELECTOR))
    .map((element) => ({ kind: "ant", element }))
    .filter((tab) => antTabTitle(tab.element));
}

function businessTabTitle(tab) {
  return tab.kind === "realTab"
    ? compactOneLine(tab.element.textContent || "")
    : antTabTitle(tab.element);
}

function businessTabActive(tab) {
  const el = tab.element;
  if (tab.kind === "realTab") {
    return el.getAttribute?.("aria-selected") === "true" || el.getAttribute?.("data-active") === "true";
  }
  return el.getAttribute?.("aria-selected") === "true";
}

function businessTabSnapshot() {
  return findBusinessTabElements().map((tab, index) => ({
    index,
    kind: tab.kind,
    text: businessTabTitle(tab),
    active: businessTabActive(tab),
    className: String(tab.element.className || "").trim().split(/\s+/).slice(0, 6),
    ariaSelected: tab.element.getAttribute?.("aria-selected") || "",
    dataActive: tab.element.getAttribute?.("data-active") || ""
  }));
}

/** 兼容旧调用：仅取标题列表（去重）。 */
function businessTabTitles() {
  return [...new Set(findBusinessTabElements().map(businessTabTitle).filter(Boolean))];
}

/** 事件委托用：从事件目标向上找最近的业务页签元素。 */
function closestBusinessTab(target) {
  if (!(target instanceof Element)) return null;
  const realTab = target.closest('[class*="realTab"]');
  if (realTab && isRealTabElement(realTab)) return { kind: "realTab", element: realTab };
  if (!isJtv1LikePage()) return null;
  const antTab = target.closest(ANT_TAB_SELECTOR);
  return antTab ? { kind: "ant", element: antTab } : null;
}

/**
 * jtv1 业务页签的直达 URL：?n=页签标题原文。
 * 聚水潭 epaas 支持用 ?n= 直接定位到对应业务页签；pageKey 只保留 origin+pathname
 * 会丢弃 query，所以拼 n= 不影响 pageKey 匹配，可用于直达与已关闭页签的重开。
 */
function jtv1TabDirectUrl(tabTitle) {
  const title = compactOneLine(tabTitle || "");
  if (!title) return "";
  try {
    const loc = typeof location !== "undefined" ? location : document?.location;
    const origin = loc?.origin || "";
    if (!origin || origin === "null") return "";
    const url = new URL(`${origin}/epaas`);
    url.searchParams.set("n", title);
    return url.href;
  } catch {
    return "";
  }
}

/**
 * 由某个数据源的 pageUrl 推导其所属 epaas 框架的 ?n= 直达 URL。
 * 与 jtv1TabDirectUrl（基于当前页 location）不同，这里基于 source.pageUrl 的
 * origin，跨框架查看（如在 tool.jushuitan.com 看 epaas 技能）也能拼对。
 * 仅当 source 本身就是 /epaas 路径时才拼；其他框架（如 sc.scm121.com 的
 * /dataCenter/adConsole/home）没有 /epaas 路径，返回空串，调用方应回退原 pageUrl。
 */
function jtv1SourceDirectUrl(sourcePageUrl, tabTitle) {
  const title = compactOneLine(tabTitle || "");
  if (!title) return "";
  try {
    const base = new URL(sourcePageUrl || "");
    if (!/^https?:$/.test(base.protocol)) return "";
    if (!/^\/epaas\/?$/.test(base.pathname)) return "";
    const url = new URL(`${base.origin}/epaas`);
    url.searchParams.set("n", title);
    return url.href;
  } catch {
    return "";
  }
}

export {
  isJtv1LikePage,
  findBusinessTabElements,
  businessTabTitle,
  businessTabActive,
  businessTabSnapshot,
  businessTabTitles,
  closestBusinessTab,
  jtv1TabDirectUrl,
  jtv1SourceDirectUrl
};
