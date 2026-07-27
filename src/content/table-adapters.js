const TABLE_ADAPTERS = [
  { name: "ant", scope: ".ant-table-wrapper", rowKeyAttrs: ["data-row-key"] },
  { name: "arco", scope: ".arco-table", rowKeyAttrs: ["data-row-key"] },
  // 只能匹配组件根节点；[class*='art-table'] 会误把 .art-table-row/.art-table-cell 当成 tableKey。
  { name: "art", scope: ".art-table", rowKeyAttrs: ["data-row-key", "data-key"] },
  { name: "aria", scope: "[role='grid'],[role='table'],[role='treegrid']", rowKeyAttrs: ["data-row-key", "data-key", "aria-rowindex"] },
  // _jtv1（聚水潭 ERP）：表头(#_jt_row_head)和表体(#_jt_body)是兄弟 div，
  // 必须放在 native 适配器之前：jtv1 页面外层常被 <table> 布局包裹，
  // 若 native 先通过 closest("table") 匹配，会用通用行/单元格提取逻辑，
  // 漏掉 _jt_cell_index 和 checkbox 列过滤，导致数据列错位。
  // 共同父元素才是真正的表格根节点。适配器使用函数式 scope 解析。
  // 该组件在根节点内嵌套原生 table#_jt_toolbar（按钮工具栏），
  // 因此行/单元格/表头提取全部由适配器钩子接管，与通用逻辑隔离。
  { name: "_jtv1", scope: (rowEl) => {
    if (!rowEl) return null;
    const body = rowEl.closest?.("#_jt_body");
    if (body) return body.parentElement;
    const head = rowEl.closest?.("#_jt_row_head");
    if (head) return head.parentElement;
    if (rowEl.matches?.("#_jt_row_head")) return rowEl.parentElement;
    return null;
  }, rowKeyAttrs: ["index", "data-po-id"],
    matchesRoot: (tableEl) => {
      const head = tableEl?.querySelector?.("#_jt_row_head");
      return Boolean(head && head.parentElement === tableEl);
    },
    // 虚拟滚动容器：#_jt_body（真实页面固定高度 + overflow-x:auto，overflow-y 随内容撑开）
    scroller: (tableEl) => tableEl.querySelector("#_jt_body"),
    // 分页器：#_jt_pagebar（span._jt_next 为下一页，未禁用态无 _jt_pagebtn_disabled）
    pagination: (tableEl) => tableEl.querySelector("#_jt_pagebar"),
    dataRows: (tableEl) => Array.from(tableEl.querySelectorAll("#_jt_body ._jt_row._jt_rh")),
    headerCells: (tableEl) => {
      const head = tableEl.querySelector("#_jt_row_head");
      if (!head) return [];
      return Array.from(head.querySelectorAll("._jt_cell_head")).filter((cell) => {
        if (cell.style?.display === "none") return false;
        if (cell.matches("._jt_cell_head_index, ._jt_cbx")) return false;
        return (cell.textContent || "").trim().length > 0;
      });
    },
    rowCells: (rowEl) => {
      if (!rowEl.matches?.("._jt_row._jt_rh")) return null;
      return Array.from(rowEl.children).filter((child) => {
        const tagName = child.tagName?.toLowerCase();
        if (tagName === "script" || tagName === "style" || tagName === "template" || tagName === "noscript") return false;
        if (child.style?.display === "none") return false;
        if (child.matches("._jt_cell_index")) return false;
        if (child.matches("[data-web2ai-derived-column]")) return false;
        if (!(child.textContent || "").trim() && child.querySelector("input[type='checkbox'], input[type='radio']")) return false;
        return true;
      });
    }
  },
  { name: "native", scope: "table", rowKeyAttrs: ["data-row-key", "data-key", "id"] }
];

function resolveTableAdapter(rowEl) {
  for (const adapter of TABLE_ADAPTERS) {
    const scope = typeof adapter.scope === "function"
      ? adapter.scope(rowEl)
      : rowEl?.closest?.(adapter.scope);
    if (scope) return { adapter, scope };
  }
  return { adapter: { name: "generic", rowKeyAttrs: ["data-row-key", "data-key", "id"] }, scope: rowEl?.parentElement || null };
}

function resolveTableRootAdapter(tableEl) {
  if (!tableEl) return null;
  for (const adapter of TABLE_ADAPTERS) {
    if (adapter.matchesRoot) {
      if (adapter.matchesRoot(tableEl)) return adapter;
      continue;
    }
    if (typeof adapter.scope === "string" && tableEl.matches?.(adapter.scope)) return adapter;
  }
  return null;
}

function getBusinessRowKey(rowEl) {
  if (!rowEl) return "";
  const { adapter } = resolveTableAdapter(rowEl);
  const attrs = [...adapter.rowKeyAttrs, "data-id", "data-uid", "row-key"];
  for (const attr of [...new Set(attrs)]) {
    const value = rowEl.getAttribute?.(attr);
    if (value) return `${adapter.name}:${attr}:${value}`;
  }
  const firstCell = rowEl.querySelector?.("[data-row-key],[data-key],[data-id]");
  if (firstCell) {
    for (const attr of ["data-row-key", "data-key", "data-id"]) {
      const value = firstCell.getAttribute(attr);
      if (value) return `${adapter.name}:${attr}:${value}`;
    }
  }
  return "";
}

/** 使用前 3 个非空业务列生成轻量内容指纹，跳过常见的空 checkbox/操作列。 */
function getRowContentFingerprint(rowText, maxColumns = 3) {
  const columns = String(rowText || "")
    .split(/\s*\|\|\|\s*/)
    .map((value) => value.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim())
    .filter((value) => value && value !== "-")
    .slice(0, maxColumns);
  if (!columns.length) return "";
  let hash = 2166136261;
  for (const char of columns.join("\u001f")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${columns.length}:${(hash >>> 0).toString(36)}`;
}

/** 当前渲染内容的稳定身份：业务 key 优先，否则使用前几列内容指纹。 */
function getRenderedRowIdentity(tableId, businessRowKey, rowText) {
  const rowIdentity = businessRowKey || getRowContentFingerprint(rowText);
  return rowIdentity ? `${tableId || "unknown-table"}::${rowIdentity}` : "";
}

export { TABLE_ADAPTERS, resolveTableAdapter, resolveTableRootAdapter, getBusinessRowKey, getRowContentFingerprint, getRenderedRowIdentity };
