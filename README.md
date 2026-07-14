# Web-to-AI Context Chat (Chrome Extension)

一款将网页内容与 AI 深度结合的 Chrome 扩展插件（Manifest V3）。

## 核心能力

- 选中网页文本后，附近出现浮动"问AI"按钮，点击将选中内容加入上下文并打开 AI 对话浮层
- 右键菜单支持：添加选中内容到 AI 上下文、添加整页内容到 AI 上下文、打开 AI Chat 浮层
- 鼠标悬停表格行时显示 checkbox，可逐行或批量选中表格数据加入上下文
- 支持跨页批量选择（自动识别 Ant Design / Arco Design 分页器，自动翻页）
- 浮层内支持流式 AI 对话（SSE），每次发送自动带上当前上下文片段
- 上下文按表格分组管理，自动识别表头并与数据行列匹配
- 支持 DeepSeek（OpenAI 兼容）接口，可在设置中配置 Base URL / Model / API Key
- 根据模型上下文窗口自动计算 token 预算，超限时优先保留表头与最近数据
- 可拖拽的浮动启动器 + 数据统计气泡

## 本地加载

1. 打开 Chrome：`chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目目录
5. 进入扩展「详情」页，打开「扩展程序选项」配置 API Key

默认建议配置：

- Base URL：`https://api.deepseek.com`
- Model：`deepseek-v4-flash`

## 隐私与权限

- API Key 使用 `chrome.storage.local` 保存在当前浏览器，不写入同步存储；旧版本中的同步密钥会自动迁移并删除。
- 选中的网页上下文使用 `chrome.storage.session` 按标签页临时保存，标签页关闭后清理。
- 扩展需要在任意网页和 iframe 内识别划词与表格，因此当前仍声明 `<all_urls>`。扩展不会自动发送网页内容，只有用户发起 AI 请求时才会把当前选中的上下文发送到配置的 API 地址。

## 使用

- 在网页上选中一段文本，点击浮出的"问AI"按钮
- 右键菜单：`添加选中内容到 AI 上下文` / `添加整页内容到 AI 上下文` / `打开 AI Chat 浮层`
- 鼠标悬停表格行 → 勾选 checkbox → 行内容加入上下文
- 点击底部"全选当前页"批量添加当前表格所有行
- 点击"跨页选择"输入页数，自动翻页并收集数据

## 架构概览

```
manifest.json                    # 扩展配置（MV3）
src/
├── shared.js                    # 共享常量（默认设置）
├── background.js                # Service Worker：右键菜单、AI API 代理、上下文存储
├── options.html/js/css          # 扩展设置页（Base URL / Model / API Key）
└── content/                     # 内容脚本（注入网页）
    ├── loader.js                # 入口：动态加载 main.js
    ├── state.js                 # 全局状态、常量、工具函数、共享引用
    ├── dom.js                   # DOM 工具：元素创建、CSS 选择器、可见性判断
    ├── main.js                  # 消息监听、storage 监听、初始化
    ├── overlay.js               # AI 对话浮层 UI（Shadow DOM）
    ├── context.js               # 上下文管理（添加/删除/分组/构建 prompt）
    ├── table.js                 # 表格交互（行检测、选择、跨页翻页）
    ├── selection.js             # 文本选中浮动按钮
    ├── messaging.js             # 与 background 的消息通信层
    ├── markdown.js              # Markdown → HTML 渲染器
    ├── highlight.js             # 页面文本高亮定位
    └── toast.js                 # Toast 提示组件
```

## 通信流程

```
┌─────────────┐     Port (流式)      ┌────────────┐     SSE Fetch      ┌────────────┐
│  content     │ ◄──────────────────► │ background │ ◄────────────────► │ DeepSeek   │
│  overlay.js  │   messaging.js        │ .js        │                    │ API        │
│  (浮层UI)    │   (chrome.runtime     │            │   /v1/chat/        │            │
│              │    .connect)          │            │   completions      │            │
└─────────────┘                       └────────────┘                    └────────────┘
       │                                     │
       │  chrome.runtime.sendMessage          │  chrome.storage.session
       │  (STORE_CONTEXT, etc.)              │  (上下文按 tab 存储)
       ▼                                     ▼
┌─────────────┐                       ┌────────────┐
│  content     │                       │  chrome.    │
│  context.js  │                       │  storage    │
└─────────────┘                       └────────────┘
```

## 消息类型一览

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `OPEN_PANEL` | bg → content | 打开浮层面板 |
| `ADD_CONTEXT_SNIPPET` | bg → content | 添加上下文片段 |
| `REMOVE_CONTEXT_BY_REF` | bg → content | 按 ref 移除上下文 |
| `UNSELECT_ROWS_BY_REFS` | bg → content | 批量取消选中行 |
| `CLEAR_ROW_UI` | bg → content | 清除所有行 UI 状态 |
| `CAPTURE_PAGE` | bg → content | 捕获页面文本 |
| `TOAST` | bg → content | 显示 Toast |
| `STORE_CONTEXT` | content → bg | 持久化上下文 |
| `REMOVE_CONTEXT` | content → bg | 移除上下文 |
| `CLEAR_CONTEXTS` | content → bg | 清除所有上下文 |
| `LIST_CONTEXTS` | content → bg | 获取上下文列表 |
| `AI_CHAT_STREAM` | content → bg (Port) | 发起流式对话 |
| `AI_CHAT_STREAM_CHUNK` | bg → content (Port) | 流式增量数据 |
| `AI_CHAT` | content → bg | 非流式 AI 请求 |
| `FORWARD_TO_TOP` | content → bg | 转发消息到 top frame |
| `BROADCAST_TO_TAB` | content → bg | 广播到所有 frame |

## 开发

```bash
# 项目无构建依赖，直接加载到 Chrome 即可
# 如需开发调试，将 state.js 中的 DEBUG 设为 true
```
