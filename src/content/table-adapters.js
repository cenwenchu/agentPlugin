const TABLE_ADAPTERS = [
  { name: "ant", scope: ".ant-table-wrapper", rowKeyAttrs: ["data-row-key"] },
  { name: "arco", scope: ".arco-table", rowKeyAttrs: ["data-row-key"] },
  // 只能匹配组件根节点；[class*='art-table'] 会误把 .art-table-row/.art-table-cell 当成 tableKey。
  { name: "art", scope: ".art-table", rowKeyAttrs: ["data-row-key", "data-key"] },
  { name: "aria", scope: "[role='grid'],[role='table'],[role='treegrid']", rowKeyAttrs: ["data-row-key", "data-key", "aria-rowindex"] },
  { name: "native", scope: "table", rowKeyAttrs: ["data-row-key", "data-key", "id"] }
];

function resolveTableAdapter(rowEl) {
  for (const adapter of TABLE_ADAPTERS) {
    const scope = rowEl?.closest?.(adapter.scope);
    if (scope) return { adapter, scope };
  }
  return { adapter: { name: "generic", rowKeyAttrs: ["data-row-key", "data-key", "id"] }, scope: rowEl?.parentElement || null };
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

export { TABLE_ADAPTERS, resolveTableAdapter, getBusinessRowKey, getRowContentFingerprint, getRenderedRowIdentity };
