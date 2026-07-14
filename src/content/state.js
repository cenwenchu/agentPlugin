/**
 * @fileoverview 全局状态与常量。
 * 包含：
 * - 环境常量（DEBUG, IS_TOP_FRAME, Z_INDEX 等）
 * - 应用级状态对象 STATE（面板、对话、上下文、草稿等）
 * - 共享可变引用 refs（DOM 节点、流处理器、行选中映射等）
 * - 工具函数（uid、clamp、normalizeText 等）
 *
 * 说明：refs 用普通对象而非 ES module export 的原因 ——
 * ES module 的 let export 在导入模块中是「只读活绑定」，
 * 这意味着其他模块只能读取但不能直接赋值。
 * 用 refs 对象包装后，其他模块可以通过 refs.xxx = ... 来写入。
 */

/** @type {boolean} 是否为顶层 frame（排除 iframe） */
const IS_TOP_FRAME = window.top === window;

/**
 * 全局应用状态对象。
 * @property {boolean} open - 面板是否打开
 * @property {Array} contexts - 当前标签页的扁平上下文列表；enabled=false 时不发送
 * @property {Array} tableGroups - 从 contexts 派生的表格视图 [{id, tableId, header, rows}]
 * @property {Array} messages - 当前页面内存中的对话；刷新后清空
 * @property {boolean} pending - 是否正在等待 AI 响应
 * @property {string} draftText - 输入框草稿文本
 * @property {Object|null} lastInputCursor - 输入框光标位置 {start, end}
 * @property {boolean} suppressAutoSuggest - 是否禁用自动建议
 * @property {boolean} maximized - 面板是否最大化
 */
const STATE = {
  open: false,
  contexts: [],
  tableGroups: [],
  messages: [],
  /** 首次无输入时生成的欢迎语和快捷问题，不进入模型对话历史 */
  onboarding: null,
  pending: false,
  draftText: "",
  lastInputCursor: null,
  suppressAutoSuggest: false,
  maximized: false
};

/** 表格列分隔符 */
const COL_SEPARATOR = " ||| ";
/** @deprecated 仅供旧版字符确认弹窗兼容；发送主路径使用模型 token 预算。 */
const CONTEXT_CHAR_LIMIT = 50000;
/** @deprecated 仅供旧版字符确认弹窗兼容；发送主路径使用模型 token 预算。 */
const CONTEXT_WARN_LIMIT = 100000;
/** 全局 z-index 基准值 */
const Z_INDEX = "1000";
/** 表格 check/bar 常规层级；固定表格需要保持高优先级。 */
const TABLE_UI_Z_INDEX = "1000";
/** 站点 Drawer/Modal 打开时临时降低，避免盖住菜单。 */
const TABLE_UI_BELOW_SITE_OVERLAY_Z_INDEX = "900";

/**
 * 生成唯一 ID。
 * @returns {string} 例如 "18d2f_3a4b5c"
 */
function uid() {
  return `${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
}

/**
 * 数值范围约束。
 * @param {number} n - 输入值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} 约束后的值
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * 文本规范化：替换不间断空格、合并多余换行、去首尾空白。
 * @param {string} s - 原始文本
 * @returns {string} 规范化后的文本
 */
function normalizeText(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 文本截断（保留尾部截断标记）。
 * @param {string} s - 原始文本
 * @param {number} maxChars - 最大字符数
 * @returns {string} 截断后的文本
 */
function truncateText(s, maxChars) {
  const t = normalizeText(s);
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n\n[Truncated: ${t.length - maxChars} chars]`;
}

/**
 * 将文本压缩为单行（合并所有空白为空格）。
 * @param {string} s - 原始文本
 * @returns {string} 单行文本
 */
function compactOneLine(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 共享可变引用对象。
 * 其他模块通过 refs.xxx 读写这些引用。
 */
const refs = {
  /** Shadow DOM 宿主节点 */
  overlayHost: null,
  /** Shadow DOM 的 shadow root */
  overlayShadow: null,
  /** 与 background 的长连接 port */
  chatPort: null,
  /** 流式请求处理器 Map<requestId, {onChunk, onEnd, onError}> */
  streamHandlers: new Map(),
  /** 当前流式消息的引用（用于增量渲染） */
  streamingMsgRef: null,
  /** RAF 调度的渲染标记（防抖） */
  renderScheduled: false,
  /** WeakMap: 行元素 → ref 标记（仅内存） */
  selectedRowRef: new WeakMap(),
  /** Map: ref → 行元素 */
  refToRowEl: new Map(),
  /** WeakMap: 实际表格组件根节点 → 当前页面生命周期唯一 tableKey */
  tableRootToKey: new WeakMap(),
  /** tableKey 实例递增序号 */
  nextTableInstanceId: 1,
  /** Map: 虚拟表格 tableKey + page + data-rowindex → ref */
  virtualRowPositionToRef: new Map(),
  /** Map: ref → 虚拟表格位置身份 */
  refToVirtualRowPosition: new Map(),
  /** Map: 稳定业务 rowKey → ref，用于虚拟滚动 DOM 复用去重 */
  rowKeyToRef: new Map(),
  /** Map: ref → 业务 rowKey，删除上下文时反向清理 */
  refToRowKey: new Map(),
  /** Map: ref → 最近渲染身份，用于识别虚拟滚动复用的 DOM 行节点 */
  refToRenderedRowIdentity: new Map(),
  /** Map: tableKey + rowKey/内容指纹 → ref，DOM 绑定丢失时仍可阻止批量重复加入 */
  renderedRowIdentityToRef: new Map(),
  /** Map: ref → {tableId, pageIndex, kind}，动态行被回收后仍可统计和批量取消 */
  refToRowMeta: new Map(),
  /** Map: ref → 行 checkbox 元素 */
  refToCheckbox: new Map(),
  /** Map: 行元素 → pinned overlay 节点 */
  pinnedRowOverlays: new Map(),
  /** 批量操作的锚点行 */
  batchAnchorRow: null,
  /** 批量操作所属组件身份；虚拟滚动无可见锚点的瞬间仍需保留 */
  batchTableId: "",
  /** 批量操作所属分页 */
  batchPageIndex: null,
  /** 页面左下角批量操作栏 */
  batchBar: null,
  /** 表格根元素 */
  batchTableRoot: null,
  /** 批量操作的容器（如抽屉、弹窗） */
  batchContainer: null,
  /** 跨页选择面板是否展开 */
  multiPageOpen: false,
  /** 跨页选择是否正在运行 */
  multiPageRunning: false,
  /** 跨页选择进度 {stop, done, total, added} */
  multiPageProgress: null,
  /** 当前悬停的行元素 */
  hoveredRow: null,
  /** 页面是否存在可见的站点 Drawer/Modal */
  siteOverlayActive: false,
  /** 浮动启动器按钮 */
  launcherFab: null,
  /** 行级别浮动操作按钮（通用） */
  tableRowFab: null,
  /** 行级别内联浮动操作按钮（tr 内） */
  inlineRowFab: null,
  /** 内联 FAB 的宿主元素 */
  inlineRowFabHost: null,
  /** 高亮回退方案的 overlay 节点 */
  fallbackHighlightBox: null,
  /** 选中文本浮动按钮 */
  selectionFab: null,
  /** 最后一次选中的快照 */
  lastSelectionSnapshot: null,
  /** 快捷键是否已绑定 */
  hotkeysBound: false,
  /** Toast 消息队列 */
  toastQueue: [],
  /** Toast 展示定时器 */
  toastTimer: null,
  /** 浮动启动器上的数据统计气泡 */
  launcherBadge: null,
  /** 临时表格诊断轨迹；仅当前 frame 内存，刷新即清空 */
  tableDiagnostics: []
};

export {
  IS_TOP_FRAME,
  STATE,
  COL_SEPARATOR,
  CONTEXT_CHAR_LIMIT,
  CONTEXT_WARN_LIMIT,
  Z_INDEX,
  TABLE_UI_Z_INDEX,
  TABLE_UI_BELOW_SITE_OVERLAY_Z_INDEX,
  uid,
  clamp,
  normalizeText,
  truncateText,
  compactOneLine,
  refs
};

/**
 * 通过此常量控制是否输出调试日志。
 * @type {boolean}
 */
const DEBUG = false;

export { DEBUG };
