# Web-to-AI Context Chat (Chrome Extension)

一款将网页内容与 AI 深度结合的 Chrome 扩展插件（Manifest V3）。

## 核心能力

- 右键菜单提供“打开 AI Chat 浮层”“截图（框选区域）”和“多屏截图（最多 5 屏）”三个入口
- 鼠标在表格行停稳约 100ms 后，“问AI”会在指针右侧水平显示，并限制在当前行高度内；位置锁定后不再追随鼠标
- 支持用户拖拽框选截图区域，并作为视觉上下文发送
- 支持从当前位置自动向下截取最多 5 屏，每屏作为独立图片上下文；完成后恢复原滚动位置
- 支持跨页批量选择（自动识别 Ant Design / Arco Design 分页器，自动翻页）
- 浮层内支持流式 AI 对话（SSE），每次发送自动带上当前上下文片段
- 上下文按表格组件实例分组，通过 `headerRef` / 运行时 `tableKey` 隔离同页多个相似表格
- 表格按首次加入顺序编号，后加入的表格编号更大并显示在顶部；无表头表格参与同一排序
- 每条上下文可单独启用或停用，每组表格可导出 Markdown / CSV
- 支持多个独立模型配置，每个模型分别设置 Base URL、Model、API Key、token 窗口和图片能力
- Chat 顶部醒目区域可随时切换已配置模型，带截图时会阻止未启用图片能力的模型发送
- 根据模型上下文窗口自动计算 token 预算，超限时优先保留表头与最近数据
- 上下文和对话仅保存在当前页面内存中，刷新或跳转后自动清空
- 首次无输入提问会生成数据概览和 3～5 个可编辑的快捷问题，不污染正常对话历史
- 可拖拽、可关闭的浮动启动器 + 数据统计气泡；点击浏览器工具栏中的扩展图标可恢复启动器
- 关闭启动器时同步停用页面表格选择，恢复启动器后重新启用，已有上下文不会丢失
- 左侧支持 Chat / 监控切换；可点选页面元素创建“出现、消失、文本变化、关键词、数字阈值”监控
- 目标标签页保持打开时，即使用户切换到其他标签页，条件满足也会发送 Chrome 系统通知并保留最近触发记录

## 本地加载

1. 打开 Chrome：`chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目目录
5. 进入扩展「详情」页，打开「扩展程序选项」新增模型并配置独立 API Key
6. 打开或刷新目标网站，页面右侧会自动出现插件入口

默认建议配置：

- Base URL：`https://api.deepseek.com`
- Model：`deepseek-v4-flash`

## 隐私与权限

- API Key 使用 `chrome.storage.local` 保存在当前浏览器，不写入同步存储；旧版本中的同步密钥会自动迁移并删除。
- 模型名称、Base URL、能力和 token 参数保存于 `chrome.storage.sync`；各模型 API Key 按模型 ID 独立保存在 `storage.local`。
- 选中的网页上下文和对话不写入浏览器存储，刷新、跳转或关闭页面后自动清空。
- 为了让页面右侧入口无需额外操作即可出现，扩展声明 `<all_urls>` 并在网页及 iframe 中自动注入轻量加载器。加载器只负责初始化交互入口；页面内容仅在用户主动选择、添加或提问时采集。

## 使用

- 右键菜单：`打开 AI Chat 浮层`
- 打开 Chat 后点击“截图”并拖拽框选目标区域；截图可预览、启用/停用或删除
- 点击“多屏截图”可从当前位置开始向下逐屏捕获，到页面底部会提前结束；滚动后按页面软稳定状态等待，最长 1.5 秒；截图瞬间隐藏提示，每屏完成后短暂显示进度，全部完成后显示总张数
- Chat 顶部可切换模型，下拉框旁通过独立提示标明“支持图片”或“不支持图片”
- 模型选择、图片能力提示、最大化、设置和关闭操作统一放在顶部同一行；“清空全部”位于右侧“清空输入”按钮下方
- 点击启动器右上角 `×` 可暂时关闭对话与表格选择能力；点击 Chrome 工具栏中的扩展图标可再次启用
- Chat 展开后，只有明确点击浮层外的网页内容才会收起；鼠标移出不会收起，插件自身按钮和 iframe 内批量操作不会误触发关闭
- 鼠标悬停表格行 → 点击鼠标附近且位置锁定的“问AI” → 行内容加入上下文，第一列出现 ✓；点击 ✓ 可取消
- 点击底部“全选当前页”批量添加当前表格所有行，并保持 Chat 展开
- 虚拟滚动表格支持手动滚动后继续添加；已加入的行即使被页面回收也会保留为数据快照
- ArtTable 使用组件实例、页码、`data-rowindex` 与前两列稳定指纹联合去重，支持“先单选、再全选当前页”
- 固化底部汇总行不会显示插件 check，也不会被单选或批量加入
- 点击"跨页选择"输入页数，自动翻页并收集数据
- 在上下文列表取消勾选可暂时排除数据，无需删除
- 上下文标题栏提供“清空上下文”，可一次移除所有表格与截图卡片，但不会清除现有对话
- 点击表格组右侧 `MD` / `CSV` 导出当前启用的数据
- 消息发送后，对话区会显示“正在等待模型回复”动态提示，收到首段内容后自动替换为模型回答
- 点击左侧“监控”→“创建监控”，在同一表单中选择页面元素、填写名称、类型和条件值；规则可暂停、继续、立即检查或删除
- 点击监控通知会切回对应标签页、打开监控面板并高亮目标元素

## 页面监控（MVP）

- 当前版本采用标签页常驻监控：浏览器需要运行，目标页面标签页需要保持打开，但无需处于前台。
- 页面变化通过 `MutationObserver` 实时检测，并每 15 秒补充检查一次；相同条件持续满足时只通知一次，恢复后再次满足才会重新通知。
- 规则和最多 20 条最近触发记录保存在 `chrome.storage.local`，不会同步到其他设备。
- 条件判断全部在浏览器本地完成，不会自动向大模型发送监控元素文本或截图。
- 元素定位优先使用 id 和稳定的 `data-*` / ARIA 属性，找不到时回退到 DOM 路径；页面结构改版后可能需要重新创建规则。
- 页面元素选择任务会广播到所有已注入的 frame；同源和跨域 iframe 都由各自的内容脚本识别具体组件，规则随后在目标 frame 内独立检查。
- 第一版不支持标签关闭后的后台抓取、自动刷新、跨设备同步或 AI 二次判断。

## 架构概览

```
manifest.json                    # 扩展配置（MV3）
src/
├── shared.js                    # 共享常量（默认设置）
├── sse.js                       # 无 DOM 依赖的 SSE 增量解析器
├── background.js                # Service Worker：菜单、消息路由和 AI API 代理
├── options.html/js/css          # 扩展设置页（Base URL / Model / API Key）
└── content/                     # 内容脚本（注入网页）
    ├── loader.js                # 入口：动态加载 main.js
    ├── state.js                 # 全局状态、常量、工具函数、共享引用
    ├── dom.js                   # DOM 工具：元素创建、CSS 选择器、可见性判断
    ├── main.js                  # 消息监听、storage 监听、初始化
    ├── overlay.js               # AI 对话浮层 UI（Shadow DOM）
    ├── monitor.js               # 页面元素监控、条件判断、触发记录和定位
    ├── context.js               # 上下文管理（添加/删除/分组/构建 prompt）
    ├── context-model.js         # 纯表格分组与 prompt 上下文模型
    ├── token-budget.js          # token 估算、窗口预算和结构化裁剪
    ├── table-export.js          # Markdown / CSV 表格导出
    ├── table.js                 # 表格交互（组件隔离、虚拟行恢复、选择、跨页翻页）
    ├── table-adapters.js        # Ant / Arco / ArtTable / ARIA / native 组件作用域与 rowKey
    ├── messaging.js             # 与 background 的消息通信层
    ├── markdown.js              # Markdown → HTML 渲染器
    ├── highlight.js             # 页面文本高亮定位
    └── toast.js                 # Toast 提示组件
```

## 通信流程

```
┌─────────────┐     Port (流式)      ┌────────────┐     SSE Fetch      ┌────────────┐
│  content     │ ◄──────────────────► │ background │ ◄────────────────► │ Compatible │
│  overlay.js  │   messaging.js        │ .js        │                    │ AI API     │
│  (浮层UI)    │   (chrome.runtime     │            │   /v1/chat/        │            │
│              │    .connect)          │            │   completions      │            │
└─────────────┘                       └────────────┘                    └────────────┘
       │                                     │
       │  chrome.runtime.sendMessage          │  chrome.storage sync/local
│  (frame 转发/设置读取)               │  配置 sync + API Key local
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
| `START_REGION_SCREENSHOT` | bg → content | 打开 Chat 并进入区域截图选择 |
| `START_MULTI_SCREEN_SCREENSHOT` | bg → content | 打开 Chat 并从当前位置启动多屏截图 |
| `SHOW_LAUNCHER` | bg → content | 恢复 Chat 启动器和表格选择能力 |
| `ADD_CONTEXT_SNIPPET` | bg → content | 添加上下文片段 |
| `REMOVE_CONTEXT_BY_REF` | bg → content | 按 ref 移除上下文 |
| `UNSELECT_ROWS_BY_REFS` | bg → content | 批量取消选中行 |
| `CLEAR_ROW_UI` | bg → content | 清除所有行 UI 状态 |
| `CAPTURE_VISIBLE_TAB` | content → bg | 捕获当前标签页可见区域截图 |
| `TOAST` | bg → content | 显示 Toast |
| `GET_SETTINGS` | content/options → bg | 获取脱敏设置，不返回 API Key |
| `SET_ACTIVE_MODEL` | content → bg | 切换当前模型配置 |
| `MONITOR_TRIGGER` | content → bg | 页面监控条件满足，创建系统通知 |
| `LOCATE_MONITOR` | bg → content | 点击通知后回到页面并定位监控元素 |
| `AI_CHAT_STREAM` | content → bg (Port) | 发起流式对话 |
| `AI_CHAT_STREAM_CHUNK` | bg → content (Port) | 流式增量数据 |
| `AI_CHAT` | content → bg | 非流式 AI 请求 |
| `FORWARD_TO_TOP` | content → bg | 转发消息到 top frame |
| `BROADCAST_TO_TAB` | content → bg | 广播到所有 frame |

## UI 状态与数据生命周期

- `launcherHidden`、启动器位置和面板最大化状态保存在 `chrome.storage.sync`，会影响同一浏览器中的所有页面 frame。
- 关闭启动器只停用页面交互，不删除已经采集的上下文；重新启用后，仍在当前页面内存中的表格选择会恢复显示。
- 上下文、对话和表格行快照只存在于页面内存，刷新或跳转后清空。
- 截图以 JPEG Data URL 保存在页面内存，单次请求最多发送最近 5 张；模型必须支持 OpenAI 兼容的视觉输入。
- 首次只有截图且输入为空时不会直接调用模型，会提示用户填写希望进行的图片分析任务。
- Chat 浮层打开时启动器暂时隐藏；关闭浮层后，只要用户没有关闭启动器，它会重新出现。
- 页面监控规则和触发记录保存在 `storage.local`；普通页面上下文及对话仍然只存在于当前页面内存。

## 开发

开发与测试要求 Node.js 20.19 或更高版本。Chrome E2E 使用有界面 Chrome，因为扩展加载通过 Puppeteer 官方 `enableExtensions` 通道完成。

```bash
# 项目无构建依赖，直接加载到 Chrome 即可
# 如需开发调试，将 state.js 中的 DEBUG 设为 true
npm test
npm run test:e2e  # 启动有界面 Google Chrome，并加载临时扩展副本
```

`npm test` 是默认提交门槛。E2E 会先验证扩展 service worker 已启动，再打开本地 fixture；扩展未加载和内容脚本未初始化会给出不同错误。

## 表格行为说明

- `tableKey` 由 frame 运行实例与组件根节点实例共同组成；同 URL 的多个 iframe 也彼此隔离，不用于刷新恢复。
- 固定表头和表体只要位于同一组件 wrapper，便共享同一个 `tableKey`；不同 wrapper 永不共享选中状态。
- 普通无业务 key 表格使用前三个非空列生成轻量指纹；ArtTable 使用前两个非空列，并额外记录页码与 `data-rowindex`。
- 虚拟列表回收 DOM 时只解除旧节点的 UI 绑定，已加入的文本快照不会丢失；重新渲染同一行时自动恢复 check。
- 表格 check/bar 固定使用 999 层级，高于普通列表，低于常见的 Drawer/Modal（1000+）。

更完整的状态模型、表格身份、存储边界和扩展路线见 [DESIGN.md](./DESIGN.md)。
