/**
 * @fileoverview 按列分析运行期行身份。
 */

import { getBusinessRowKey, getRenderedRowIdentity } from "./table-adapters.js";
import { getBusinessRowText } from "./table-row-dom.js";

function buildDerivedRuntimeTableId(skillId = "", sourceId = "") {
  return `derived-runtime:${String(skillId || "").trim()}:${String(sourceId || "").trim()}`;
}

function buildDerivedRuntimeRowIdentity({
  rowEl = null,
  tableId = "",
  rowIndex = 0,
  rowFingerprint = ""
} = {}) {
  const stableTableId = String(tableId || "derived-runtime").trim();
  const businessRowKey = getBusinessRowKey(rowEl);
  if (businessRowKey) return `${stableTableId}::${businessRowKey}`;

  const virtualRowIndex = rowEl?.getAttribute?.("data-rowindex");
  if (virtualRowIndex != null && virtualRowIndex !== "") {
    return `${stableTableId}::virtual:${virtualRowIndex}`;
  }

  const businessRowText = getBusinessRowText(rowEl, {
    separator: " ||| ",
    emptyPlaceholder: ""
  });
  const renderedIdentity = getRenderedRowIdentity(stableTableId, "", businessRowText);
  if (renderedIdentity) return renderedIdentity;

  if (rowFingerprint) return `${stableTableId}::fingerprint:${rowFingerprint}::row:${rowIndex}`;
  return `${stableTableId}::row:${rowIndex}`;
}

export {
  buildDerivedRuntimeRowIdentity,
  buildDerivedRuntimeTableId
};
