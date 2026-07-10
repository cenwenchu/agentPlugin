const DEBUG = false;
const IS_TOP_FRAME = window.top === window;

const STATE = {
  open: false,
  contexts: [],
  tableGroups: [], // { id, header: item|null, rows: [item] }
  messages: [],
  pending: false,
  nextCtxNum: 1,
  draftText: "",
  lastInputCursor: null,
  suppressAutoSuggest: false,
  maximized: false
};

const COL_SEPARATOR = " ||| ";
const CONTEXT_CHAR_LIMIT = 50000;
const CONTEXT_WARN_LIMIT = 100000;

function uid() {
  return `${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(s, maxChars) {
  const t = normalizeText(s);
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n\n[Truncated: ${t.length - maxChars} chars]`;
}

function compactOneLine(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Mutable shared variables — use a refs object so other modules can read AND write
// (ES module let exports are read-only live bindings from importing modules)
const refs = {
  overlayHost: null,
  overlayShadow: null,
  chatPort: null,
  streamHandlers: new Map(),
  streamingMsgRef: null,
  renderScheduled: false,
  selectedRowRef: new WeakMap(),
  refToRowEl: new Map(),
  refToCheckbox: new Map(),
  pinnedRowOverlays: new Map(),
  batchAnchorRow: null,
  batchTableRoot: null,
  batchContainer: null,
  multiPageOpen: false,
  multiPageRunning: false,
  multiPageProgress: null,
  hoveredRow: null,
  launcherFab: null,
  tableRowFab: null,
  inlineRowFab: null,
  inlineRowFabHost: null,
  fallbackHighlightBox: null,
  selectionFab: null,
  lastSelectionSnapshot: null,
  hotkeysBound: false,
  toastQueue: [],
  toastTimer: null
};

export {
  DEBUG,
  IS_TOP_FRAME,
  STATE,
  COL_SEPARATOR,
  CONTEXT_CHAR_LIMIT,
  CONTEXT_WARN_LIMIT,
  uid,
  clamp,
  normalizeText,
  truncateText,
  compactOneLine,
  refs
};
