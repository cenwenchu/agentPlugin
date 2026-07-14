# Web-to-AI Context Chat 设计说明

## 1. 产品边界

扩展负责从用户当前浏览的页面显式采集上下文，并将这些上下文连同问题发送到用户配置的 OpenAI Chat Completions 兼容接口。它不是自动爬虫：只有用户选中内容、勾选表格行或执行整页捕获后，数据才进入上下文；只有用户发起提问后，启用的上下文才会发送到 API。

## 2. 运行时分层

### Content scripts

`loader.js` 在所有 frame 中加载内容模块。iframe 负责采集自身 DOM，顶层 frame 负责聊天浮层和统一状态展示。跨 frame 操作通过 background 转发，网页自身脚本不能直接访问扩展模块状态。

### Background Service Worker

`background.js` 负责右键菜单、tab/frame 消息路由、临时状态存储和 AI 请求。API Key 只在 background 和 options 页面读取，不通过 `GET_SETTINGS` 返回给内容脚本。

### 纯逻辑模块

- `context-model.js`：从扁平上下文派生表格组，并构建发给模型的上下文块。
- `token-budget.js`：估算 token、扣除历史与输出预留、选择可发送上下文。
- `table-export.js`：把表格组转换为 Markdown 或 CSV。
- `sse.js`：处理任意网络 chunk 边界和无尾换行 SSE 事件。

纯逻辑模块不访问 DOM 或 Chrome API，可直接通过 Node 单元测试验证。

## 3. 状态模型

### Context

核心字段：

| 字段 | 含义 |
|---|---|
| `id` | 单次运行中的对象 ID |
| `ref` | 跨 frame、存储和 UI 清理使用的 `CTX<n>` 引用 |
| `kind` | `selection`、`page`、`table-header`、`table-row` 等 |
| `text` | 发送与展示使用的规范化文本 |
| `enabled` | `false` 表示保留但不发送、不导出 |
| `tableId` | 表格 DOM 身份，用于区分列结构相同的不同表格 |
| `headerRef` | 数据行对应表头的显式引用，优先级高于 `tableId` |
| `pageIndex` | 跨页采集时的来源页码 |
| `anchorSelector` / `quote` | 刷新后尝试定位原页面元素 |

`STATE.contexts` 是当前页面内存中的事实来源；`STATE.tableGroups` 是派生视图。两者都不持久化，页面刷新或跳转后清空。

### 表格分组规则

分组优先级为：

1. 数据行的 `headerRef` 指向具体表头。
2. 没有显式表头引用时使用 `tableId`。
3. 升级前的旧数据按相邻表头顺序兼容恢复。

`headerRef` 用于处理固定表头和表体被框架拆成两个 `<table>` 的情况；`tableId` 用于避免页面上两个列名相同的表格被合并。列数和表头文本只用于发现与校验，不作为主要身份。

当前 `tableId` 仍以最近的表格语义根 selector 为主。未来应升级为组件容器级 `tableKey`，优先识别 `.ant-table-wrapper`、`.arco-table`、`.art-table`、`[role=grid]` 等共同作用域。

## 4. 发送流程与 token 预算

### 首次引导

第一次点击“问一下”且输入为空时，扩展不会把内部引导提示词写入 `STATE.messages`。它通过独立的非流式请求发送表格数量、行数、列结构和每表最多两条样例，要求模型返回结构化 JSON。UI 将欢迎语、概览和 3～5 个建议渲染为按钮；点击按钮只填入输入框，用户可修改后再发送。JSON 解析或网络请求失败时使用本地通用建议兜底。

正常问题发送前依次执行：

1. 过滤 `enabled === false` 的上下文。
2. 选取最近 3–5 轮对话。
3. 从模型窗口中扣除输出预留、历史消息和固定安全余量。
4. 优先保留表头，再按最近选择顺序加入完整上下文项。
5. 使用筛选后的上下文构建 system message。
6. 通过 Port 请求 background 发起 SSE 流式调用。

token 估算不依赖供应商 tokenizer：非 ASCII 近似一字符一 token，ASCII 近似四字符一 token。因此它是保护性预算，不是准确计费值。对预算要求严格的供应商应增加专用 tokenizer adapter。

## 5. 存储与隐私

| 存储区 | 数据 | 生命周期 |
|---|---|---|
| `storage.local` | API Key | 当前浏览器扩展安装周期 |
| `storage.sync` | Base URL、模型、token 设置、UI 位置 | 浏览器账号同步 |
| 页面内存 | 上下文、表格派生视图、对话 | 刷新、跳转或关闭页面时清空 |

旧版本同步存储中的 API Key 会在首次读取时迁移到 local，并删除同步副本。

上下文不再写入 `storage.session`，因此没有固定 50 条存储上限，也不存在恢复后的 DOM 对应关系失效问题。发送量仍受 token 预算控制；大量数据的 UI 性能应通过折叠或虚拟列表解决，而不是静默淘汰上下文。

## 6. 跨页表格

跨页选择保存当前表格作用域与内容摘要，触发下一页后使用 `MutationObserver` 优先检测 DOM 变化，并以低频轮询兜底。DOM 整体替换后会重新定位 live table、清理断开的行引用并更新锚点。

该功能属于启发式自动化，不保证适配所有服务端分页、虚拟滚动和 canvas 表格。新增框架适配时应保持通用 ARIA fallback。

## 7. 错误与安全边界

- AI 返回 Markdown 在生成 HTML 前先转义原始 HTML，并限制链接为 HTTP(S)。
- 网页上下文在 prompt 中标记为不可信数据，不能完全消除提示注入风险。
- 流式请求断开会取消对应 `AbortController`。
- API 错误目前会显示部分服务端响应；后续应增加脱敏和结构化错误码。
- `<all_urls>` 与 `all_frames` 是当前任意网页采集能力的基础，也是主要权限成本。

## 8. 后续优化路线

### P0：可靠性

- 移除无条件整请求重试；已收到部分 token 后提供“继续生成”。
- 增加真实 Chrome 环境的端到端测试，覆盖 iframe、刷新清空、固定表头和跨页 DOM 替换。

### P1：表格身份

- 引入组件容器级 `tableKey`，并把 Ant Design、Arco、ArtTable 规则拆成 adapter。
- 对虚拟滚动表格使用业务 row key 或可配置主键，避免 DOM 节点复用导致选择漂移。
- 为跨页任务持久化来源页、行 key 和去重摘要。

### P1：模型兼容

- 为不同供应商抽象请求字段，如 `max_tokens` / `max_completion_tokens`、错误格式和流式事件。
- 支持供应商专用 tokenizer，显示估算值和实际 usage。
- 增加超时、429/5xx 指数退避和并发限制。

### P2：权限与性能

- 改为站点启用列表和按需注入，逐步减少 `<all_urls>` 常驻内容脚本。
- 对大型页面减少全局 selector 扫描，统一使用作用域内 MutationObserver。
- 拆分 `table.js` 和 `overlay.js`，降低循环依赖与单文件复杂度。

## 9. 测试

运行：

```bash
npm test
```

当前测试覆盖纯分组、固定表头关联、上下文隔离、token 预算、SSE chunk 边界以及 Markdown/CSV 导出。静态回归负责语法、调试日志、demo HTML 结构和关键导出检查。浏览器 E2E 还应验证页面刷新后上下文与对话均为空。
