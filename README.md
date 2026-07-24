# Web-to-AI Context Chat (Chrome Extension)

一款将网页内容与 AI 深度结合的 Chrome 扩展插件（Manifest V3）。

## 核心能力

- 右键菜单提供“打开 AI Chat 浮层”“截图（框选区域）”“多屏截图（最多 5 屏）”和“创建技能”入口
- 鼠标在表格行停稳约 100ms 后，“采”会在指针右侧水平显示，并限制在当前行高度内；位置锁定后不再追随鼠标
- 支持用户拖拽框选截图区域，并作为视觉上下文发送
- 支持从当前位置自动向下截取最多 5 屏，每屏作为独立图片上下文；完成后恢复原滚动位置
- 支持跨页批量选择（自动识别 Ant Design / Arco Design 分页器，自动翻页）
- 浮层内支持流式 AI 对话（SSE），每次发送自动带上当前上下文片段
- 上下文按表格组件实例分组，通过 `headerRef` / 运行时 `tableKey` 隔离同页多个相似表格
- 表格按首次加入顺序编号，后加入的表格编号更大并显示在顶部；无表头表格参与同一排序
- 每条上下文可单独启用或停用，每组表格可导出 Markdown / CSV
- 支持多个独立模型配置，每个模型分别设置 Base URL、Model、API Key 和图片能力；新增模型与已有模型修改使用独立界面
- 设置页可将任意模型设为默认；新打开或刷新的页面使用默认模型，Chat 顶部切换只影响当前页面会话
- OpenAI 兼容服务若连接测试成功但 SSE 流式通道不可用，会在两次首段连接失败后自动改用同模型的非流式兼容模式
- 模型请求只发送必需的 `model`、`messages`，流式请求额外发送 `stream: true`；温度、最大输出等可选生成参数使用模型服务默认值
- 流式请求在模型首段内容返回前使用不含业务数据的轻量心跳，避免 Chrome MV3 Background 因30秒空闲被回收
- Chat 顶部醒目区域可随时切换已配置模型，带截图时会阻止未启用图片能力的模型发送
- 根据模型上下文窗口自动计算 token 预算，超限时优先保留表头与最近数据
- 上下文和对话仅保存在当前页面内存中，刷新或跳转后自动清空
- 首次无输入提问会生成数据概览和 3～5 个可编辑的快捷问题，不污染正常对话历史
- 可拖拽、可关闭的浮动启动器 + 数据统计气泡；点击浏览器工具栏中的扩展图标可恢复启动器
- 关闭启动器时同步停用页面表格选择，恢复启动器后重新启用，已有上下文不会丢失
- Chat Tab 的“页面问AI”开关可单独隐藏表格行悬停时出现的“问AI”入口；关闭后 Chat、已有上下文、选中标记、批量栏和技能仍可使用，设置会同步到所有页面 frame
- 左侧“技能”支持为整表分析技能绑定最多 5 个数据源；按列分析当前只绑定 1 个数据源。数据源可来自同一页面的多张表，也可切换到其他已打开页面选择；保存后分别持久化页面、frame、数据源定位和字段指纹
- 创建和修改技能都在 Chat 的技能 Tab 内完成；选择数据源期间可切换业务页面，选中后自动回到原 Chat 草稿
- 新绑定会额外记录版本化 frame 路径提示、selector 强度、组件类型和容器签名；旧绑定继续使用原有 frame URL、selector 和序号规则。新绑定出现多个可能位置时要求重新选择，不会按表头相似度自动串绑
- 技能使用单个自然语言输入框描述分析需求；数据源名称在首次选择或主动重新选择时生成，用户可在编辑模式中修改，非编辑模式不会自动改名
- 技能支持两种类型：`整表分析` 负责对整张表输出整体结论；`按列分析` 会基于所选字段为当前页多行逐条生成结论，并以原生插列方式展示在表格中
- 配置分析方法后可进入全屏“测试技能”：可视化预览采集数据并支持每页 10 条浏览，每个数据源最多采集 30 页或 1000 行；采集支持 Ant Design、Arco、ArtTable 和通用虚拟滚动表格，会逐页滚动收集被回收的行并展示进度；测试与正式执行使用相同的最简请求并原样展示模型输出，支持修改后再次测试和保存，也可另行点击“优化分析方法”获取不影响实际结果的建议
- 已绑定的数据源上方显示“技能列表：”横条，同一数据源的技能自动换行排列；整表分析点击“执行”后先进入全屏执行页，再由用户点击“执行技能”载入并分析；按列分析支持页面内“自动执行”与“更新”两种入口
- 技能测试和执行会依次采集所有数据源，实时展示每个数据源的页数、滚动次数与累计行数；每个数据源最多 30 页或 1000 行，采集后恢复第一页和表格顶部。任何数据源未完成时不会把不完整数据提交给模型
- 技能分页和虚拟滚动采集采用自适应稳定等待：根据可见行内容及页面 loading 状态决定何时继续，快速页面不再为每次翻页或滚动固定等待两秒；普通表格跨页选择仍保留原有保守等待策略
- 测试和执行的分析结果框会区分处理阶段：采集期间醒目显示“正在采集数据...”，请求提交后改为“已经提交给大模型，正在等待模型返回...”，避免把模型等待时间误认为仍在采集
- 采集结果区分完整、有界完整、用户取消、翻页失败和翻页状态不确定；部分数据仍可预览和排障，但停止、失败或不确定结果不会被静默提交给模型
- 测试和执行都在用户点击开始后检查每个数据源是否分页。可输入 0–30，输入框默认 1，其中 0 表示全部；为兼容旧习惯仍接受“全部”文本。全部最多采集 30 页。取消页数选择只终止本次载入，工作台保持打开并提示本次未提交，可直接重新开始
- 测试模式只有当本次工作台里的所有数据源都已完整载入时才会复用缓存；如果上一次采集因用户停止、翻页失败或结果不确定而未完整结束，再次点击“开始测试/再次测试”会重新采集，不需要退出工作台重进
- 测试页和执行页可分页查看本次载入的全部数据，每页 10 条；预览翻页仅切换内存数据，不会再次操作业务页面或重复请求模型
- 测试和执行全屏页面可上传 CSV、TSV 或 XLSX 作为临时数据源；Excel 多工作表时选择其中一个。文件只在当前全屏会话内存中使用，不写入技能、导入导出或浏览器存储，退出后释放
- 测试和执行在组装模型请求后提供“查看提交内容”，以只读大文本框展示最近一次实际发送的完整用户消息，并支持复制；后续修改分析方法或临时数据源不会篡改该次请求快照
- 技能提交预算根据当前模型的上下文窗口、输出预留和分析方法长度动态计算，并在多数据源之间平均分配
- 技能继续使用原有 `storage.local` 数组格式，但新增、修改、删除、导入和兼容迁移统一由 background 串行写入；技能 revision 可阻止旧草稿覆盖其他页面的新修改
- 按列分析运行期缓存同时保存在页面内存和 `chrome.storage.session`，默认 TTL 2 小时；返回上一页时会优先命中缓存恢复，不重复请求模型
- 按列分析页面访问频控按 `page + model` 维度累计；列表变化只会重新进入调度判断，不会重置当前页面对该模型的总请求次数
- 技能编辑支持“复用已有数据源”，会按页面、frame、selector、表序和字段指纹去重，兼容新旧绑定格式
- Chat 的“全部技能”顶部支持导出全部技能为 JSON，并支持导入技能文件做预检查：会过滤重复技能、校验绑定是否合法、汇总失败项，再由 background 在最新集合上串行合并写入
- “全部技能”支持一键删除全部技能；“当前页面技能”卡片使用显式“删除”按钮逐条删除；“其他页面技能”区域只负责页面跳转和编号摘要，不承载单技能删除
- “其他页面技能”折叠态会保留至少两条技能摘要可见，点击页面条目切页时会优先尝试该页面中第一个仍有效的数据源进行定位；若首个技能已 `changed/missing/ambiguous`，仍会继续尝试后续可用技能

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
- 右键点击“创建技能”会直接进入数据源选择；选中后自动打开 Chat、切换到技能 Tab，并将数据源填入新技能草稿
- 打开 Chat 后点击“截图”并拖拽框选目标区域；截图可预览、启用/停用或删除
- 在 Chat 的上下文标题栏关闭“页面问AI”，可停止显示网页表格行上的“问AI”悬停入口；重新打开即可恢复
- 点击“多屏截图”可从当前位置开始向下逐屏捕获，到页面底部会提前结束；滚动后按页面软稳定状态等待，最长 1.5 秒；截图瞬间隐藏提示，每屏完成后短暂显示进度，全部完成后显示总张数
- Chat 顶部可切换模型，下拉框旁通过独立提示标明“支持图片”或“不支持图片”
- 模型选择、图片能力提示、最大化、设置和关闭操作统一放在顶部同一行；“清空全部”位于右侧“清空输入”按钮下方
- 点击启动器右上角 `×` 可暂时关闭对话与表格选择能力；点击 Chrome 工具栏中的扩展图标可再次启用
- Chat 展开后，只有明确点击浮层外的网页内容才会收起；鼠标移出不会收起，插件自身按钮和 iframe 内批量操作不会误触发关闭
- 鼠标悬停表格行 → 点击鼠标附近且位置锁定的“采” → 行内容加入上下文，第一列出现 ✓；点击 ✓ 可取消
- 点击底部“全选当前页”批量添加当前表格所有行，并保持 Chat 展开
- 虚拟滚动表格支持手动滚动后继续添加；已加入的行即使被页面回收也会保留为数据快照
- ArtTable 使用组件实例、页码、`data-rowindex` 与前两列稳定指纹联合去重，支持“先单选、再全选当前页”
- 固化底部汇总行不会显示插件 check，也不会被单选或批量加入
- 点击"跨页选择"输入页数，自动翻页并收集数据
- 在上下文列表取消勾选可暂时排除数据，无需删除
- 上下文标题栏提供“清空上下文”，可一次移除所有表格与截图卡片，但不会清除现有对话
- 点击表格组右侧 `MD` / `CSV` 导出当前启用的数据
- 消息发送后，对话区会显示“正在等待模型回复”动态提示，收到首段内容后自动替换为模型回答
- 点击左侧“技能”可创建技能并在页面上选择数据源；创建或修改时可编辑数据源显示名称。刷新后只校验当前页面的数据源并展示“校验中、可用、数据源已变化、数据源位置不明确、数据源失效”；其他页面默认显示“执行时校验”，在测试或执行采集时再校验
- “创建技能/修改技能”支持保存自然语言分析方法；早期五段式配置会自动合并到单个输入框，未配置的旧技能仍标记为“尚未配置分析方法”
- 点击“导出技能”会下载当前全部技能与页面显示名称；若扩展刚热更新导致页面上下文失效，会提示刷新当前页面后重试，而不是继续抛出未捕获错误
- 点击“导入技能”会先展示导入结果预览，包括成功数、重复数和失败原因；确认后才真正写入技能列表
- 测试或执行时点击“上传 CSV / Excel”可添加最多 5 个临时文件数据源；单文件最大 10MB，单工作表最多 10,000 行/500 列/1,000,000 单元格。XLSX 单条目解压后最大 32MB，总解压体积最大 64MB

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
    ├── overlay.js               # Chat、技能目录与 Shadow DOM 外壳
    ├── skill-workspace-state.js # 技能测试/执行会话状态与纯派生规则
    ├── skill-workspace-controller.js # 工作台采集、提交、保存与运行时动作
    ├── skill-workspace-view.js  # 测试/执行工作台 DOM 渲染与事件绑定
    ├── skill-workspace-style.js # 工作台专用 Shadow DOM 样式
    ├── skill-runtime-file-source.js # 会话级 CSV/XLSX 数据源装载
    ├── skills.js                # 技能编辑、持久化、页面挂接及兼容 facade
    ├── skill-source-dom.js     # 数据源 DOM 描述、定位、校验与当前页读取
    ├── skill-collector.js      # 分页、虚拟滚动采集、停止与页面恢复
    ├── skill-collection-model.js # 虚拟滚动判断与滚动步长纯计算规则
    ├── skill-source-model.js    # 版本化数据源定位、frame 路径提示与歧义判断
    ├── skill-storage-model.js   # 技能 mutation、revision 与导入合并规则
    ├── skill-request-model.js   # 单表/多表技能请求装配与完整性判断
    ├── derived-column-model.js  # 按列分析数据模型、兼容归一化与默认值
    ├── derived-column-fingerprint.js # 按列分析分析指纹 / 行指纹
    ├── derived-column-request-model.js # 按列分析测试预览与运行时请求装配
    ├── derived-column-cache.js  # 按列分析运行期缓存（memory + storage.session）
    ├── derived-column-row-identity.js # 按列分析行身份与表身份
    ├── derived-column-renderer.js # 按列分析原生插列渲染
    ├── derived-column-controller.js # 按列分析自动执行、手动更新、频控与缓存恢复
    ├── spreadsheet-file.js     # 本地 CSV/TSV/XLSX 解析（仅运行时内存）
    ├── context.js               # 上下文管理（添加/删除/分组/构建 prompt）
    ├── context-model.js         # 纯表格分组与 prompt 上下文模型
    ├── token-budget.js          # token 估算、窗口预算和结构化裁剪
    ├── table-export.js          # Markdown / CSV 表格导出
    ├── table.js                 # 表格选择、虚拟行恢复与跨页业务编排
    ├── table-row-dom.js        # HTML/ARIA 行与单元格语义
    ├── table-header-resolver.js # 固定表头和兄弟 table 表头关联
    ├── table-pagination-dom.js # 分页器定位、点击与页面稳定性检测
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
| `AI_CHAT_STREAM` | content → bg (Port) | 发起流式对话 |
| `AI_CHAT_STREAM_CHUNK` | bg → content (Port) | 流式增量数据 |
| `AI_CHAT` | content → bg | 非流式 AI 请求 |
| `FORWARD_TO_TOP` | content → bg | 转发消息到 top frame |
| `BROADCAST_TO_TAB` | content → bg | 广播到所有 frame |
| `OPEN_SKILLS_PANEL` / `START_SKILL_CREATION` | bg → content | 打开技能页或直接进入数据源选择 |
| `INSPECT_SKILL_SOURCE_PAGINATION` | content → bg → frame | 检查数据源是否支持分页 |
| `LOAD_SKILL_SOURCE_DATA` | content → bg → frame | 启动分页/虚拟滚动数据采集 |
| `STOP_SKILL_SOURCE_COLLECTION` | content → bg → frame | 停止正在进行的数据采集 |
| `SKILL_COLLECTION_PROGRESS` | frame → bg → top frame | 上报页码、滚动和累计行数 |
| `MUTATE_SKILLS` | top frame → bg | 串行执行技能新增、修改、删除、导入和兼容字段补齐 |

## UI 状态与数据生命周期

- `launcherHidden`、`tableAskAiEnabled`、启动器位置和面板最大化状态保存在 `chrome.storage.sync`，会影响同一浏览器中的所有页面 frame。
- 关闭启动器只停用页面交互，不删除已经采集的上下文；重新启用后，仍在当前页面内存中的表格选择会恢复显示。
- 上下文、对话和表格行快照只存在于页面内存，刷新或跳转后清空。
- 技能配置保存在 `storage.local`。内容脚本直接读取以保持原格式兼容，全部写操作通过 background 单队列 mutation 合并最新集合；同一技能使用 revision 检测陈旧草稿。Chat 技能页保留全部技能目录和其他页面的快速入口，卡片区展示当前页面相关技能。技能包含 1–5 个独立网页数据源绑定、自然语言分析方法及数据源显示名称；旧版单数据源技能读取时兼容为 `sources[0]`。测试和执行还可加入最多 5 个仅本次会话有效的本地文件数据源。全部数据源完成后按独立区块一次性提交模型；采集和文件解析结果只存在于当前测试或执行会话内存中。
- 截图以 JPEG Data URL 保存在页面内存，单次请求最多发送最近 5 张；模型必须支持 OpenAI 兼容的视觉输入。
- 首次只有截图且输入为空时不会直接调用模型，会提示用户填写希望进行的图片分析任务。
- Chat 浮层打开时启动器暂时隐藏；关闭浮层后，只要用户没有关闭启动器，它会重新出现。

## 开发

开发与测试要求 Node.js 20.19 或更高版本。Chrome E2E 使用有界面 Chrome，因为扩展加载通过 Puppeteer 官方 `enableExtensions` 通道完成。

```bash
# 项目无构建依赖，直接加载到 Chrome 即可
# 如需开发调试，将 state.js 中的 DEBUG 设为 true
npm test
npm run test:e2e  # 启动有界面 Google Chrome，并加载临时扩展副本
```

`npm test` 是默认提交门槛，会检查全部 `src/**/*.js` 的语法、Manifest 显式入口、调试日志规范、禁止提交 `.log/.txt` 调试产物、demo HTML 结构以及纯逻辑单元测试。单元测试包括多数据源请求分区、空单元格对齐、模型感知预算、完整性判断、工作台会话派生状态、运行时文件装载、CSV/TSV 解析、按列分析频控 / 缓存 / 指纹，以及表格资源上限。`npm run test:e2e` 会先验证扩展 service worker 已启动，再覆盖技能创建、修改、按列分析运行时、页面访问频控、技能目录交互、CSV/XLSX 临时上传和刷新持久化。

### 技能采集排障

AI 和基础表格诊断日志默认仍跟随 `background.js` 的 `DIAGNOSTIC_LOGS` 与内容脚本 `state.js` 的 `DEBUG`。技能排障日志目前保持较高可见性：`web2ai.skill-source`、`web2ai.skill-panel`、`web2ai.skill-workspace` 与 `web2ai.derived-runtime` 默认开启，用于排查跨 frame 调度、数据源校验、分页采集、缓存恢复与结果列重建。所有日志都只允许包含 frame、DOM 特征、页码、滚动尺寸、行数和消息长度，不得输出业务单元格、完整提示词或 API Key；排障后如无必要应继续收敛到结果级日志。

## 表格行为说明

- `tableKey` 由 frame 运行实例与组件根节点实例共同组成；同 URL 的多个 iframe 也彼此隔离，不用于刷新恢复。
- 固定表头和表体只要位于同一组件 wrapper，便共享同一个 `tableKey`；不同 wrapper 永不共享选中状态。
- 普通无业务 key 表格使用前三个非空列生成轻量指纹；ArtTable 使用前两个非空列，并额外记录页码与 `data-rowindex`。
- 虚拟列表回收 DOM 时只解除旧节点的 UI 绑定，已加入的文本快照不会丢失；重新渲染同一行时自动恢复 check。
- 表格 check/bar 固定使用 999 层级，高于普通列表，低于常见的 Drawer/Modal（1000+）。

更完整的状态模型、表格身份、存储边界和扩展路线见 [DESIGN.md](./DESIGN.md)。
