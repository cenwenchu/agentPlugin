# Web-to-AI Context Chat 设计说明

## 1. 产品边界

扩展负责从用户当前浏览的页面显式采集表格或截图，并将这些上下文连同问题发送到用户配置的 OpenAI Chat Completions 兼容接口。普通 Chat 只有在用户选择表格、截图或提问后才采集和发送数据；技能执行则按用户保存的数据源和分析方法，在用户点击执行后启动可见、可停止的分页/滚动采集。选中文字和整页文本采集入口已经移除。右键菜单提供打开 Chat、区域截图、多屏截图和创建技能入口。

## 2. 运行时分层

### Content scripts

`loader.js` 在所有 frame 中加载内容模块。iframe 负责采集自身 DOM，顶层 frame 负责聊天浮层和统一状态展示。跨 frame 操作通过 background 转发，网页自身脚本不能直接访问扩展模块状态。

### Background Service Worker

`background.js` 负责右键菜单、tab/frame 消息路由、扩展工具栏点击处理、AI 请求和技能配置的串行 mutation。技能仍使用原有 `storage.local` 数组 schema；background 只集中协调“读取最新值 → 修改 → 写回”，避免不同页面各自执行全量覆盖。每个模型的 API Key 只在 background 和 options 页面读取，不通过 `GET_SETTINGS` 返回给内容脚本。

### 纯逻辑模块

- `context-model.js`：从扁平上下文派生表格组，并构建发给模型的上下文块。
- `token-budget.js`：估算 token、扣除历史与输出预留、选择可发送上下文。
- `table-export.js`：把表格组转换为 Markdown 或 CSV。
- `skill-collection-model.js`：判断滚动区域是否具有虚拟化特征、计算下一次滚动位置，并把采集结束原因归类为完整、有界完整、取消、失败或结果不确定。
- `skill-source-model.js`：生成 frame 路径提示，并按新旧数据版本选择 frame 和表格候选；不访问 DOM。
- `skill-storage-model.js`：在最新技能集合上执行目标 mutation、revision 冲突检测和导入合并。
- `skill-workspace-state.js`：创建测试/执行会话，并计算数据完整性、预览分页、方法脏状态和采集进度；不访问 DOM 或 Chrome API。
- `sse.js`：处理任意网络 chunk 边界和无尾换行 SSE 事件。

纯逻辑模块不访问 DOM 或 Chrome API，可直接通过 Node 单元测试验证。

### 表格与技能 DOM 模块

- `table-row-dom.js`：统一 HTML、ARIA 和 div 表格的行/单元格语义。
- `table-header-resolver.js`：处理固定表头、表头表体拆分和兄弟 table 关联。
- `table-pagination-dom.js`：定位分页器、执行一次激活并等待页面数据稳定。
- `skill-source-dom.js`：描述、恢复、校验技能数据源并读取当前渲染行。
- `skill-collector.js`：执行分页和虚拟滚动采集，管理停止状态及恢复第一页/顶部。

`table.js` 和 `skills.js` 继续作为原有公开接口的 facade，因此调用方不需要批量迁移。`main.js` 在初始化时向 `context.js` 注入表格 UI 和 Overlay 动作，向 `table.js` 注入 render；这消除了 `table → context → overlay → table` 静态循环，同时保留原来的同步重绘时序。

## 3. 状态模型

### Context

核心字段：

| 字段 | 含义 |
|---|---|
| `id` | 单次运行中的对象 ID |
| `ref` | 跨 frame、存储和 UI 清理使用的 `CTX<n>` 引用 |
| `kind` | `page`、`table-header`、`table-row`、`snippet` 等 |
| `text` | 发送与展示使用的规范化文本 |
| `enabled` | `false` 表示保留但不发送、不导出 |
| `tableId` | 兼容字段名，实际保存当前页面生命周期内的组件实例 `tableKey` |
| `headerRef` | 数据行对应表头的显式引用，优先级高于 `tableId` |
| `pageIndex` | 跨页采集时的来源页码 |
| `anchorSelector` / `quote` | 刷新后尝试定位原页面元素 |
| `imageData` | 截图的 JPEG Data URL，仅 `screenshot` 类型使用 |

`STATE.contexts` 是当前页面内存中的事实来源；`STATE.tableGroups` 是派生视图。两者都不持久化，页面刷新或跳转后清空。

### 表格分组规则

分组优先级为：

1. 数据行的 `headerRef` 指向具体表头。
2. 没有显式表头引用时使用 `tableId`。
3. 旧格式数据按相邻表头顺序兼容分组（仅内存兼容，不提供刷新恢复）。

`headerRef` 用于处理固定表头和表体被框架拆成两个 `<table>` 的情况；`tableId` 用于避免页面上两个列名相同的表格被合并。列数和表头文本只用于发现与校验，不作为主要身份。

表格身份由 `table-adapters.js` 解析组件级作用域：Ant Design 使用 `.ant-table-wrapper`，Arco 使用 `.arco-table`，ArtTable 严格使用组件根 `.art-table`，随后回退到 ARIA 和原生 table。每个 frame 先生成运行实例命名空间，每个实际根节点再通过 `WeakMap` 获得组件实例编号，两者共同组成当前页面生命周期内唯一的 `tableKey`。固定表头与表体共享 wrapper 时共享 key；同 URL 的多个 iframe、两个结构和列内容完全相同的 wrapper 也不会碰撞。项目已删除刷新恢复，因此无需用脆弱的 CSS selector 换取跨刷新稳定性。

虚拟滚动优先读取 `data-row-key`、`data-key`、`data-id`、`row-key` 等业务标识。普通表格没有显式 key 时使用前三个非空业务列的规范化指纹；ArtTable 使用前两个非空业务列，并额外维护 `tableKey + pageIndex + data-rowindex` 的位置身份，覆盖顶部常驻行和回收行。选中时立即保存文本快照。DOM 节点复用于新数据时只解除旧节点 UI 绑定，不删除旧快照；同一数据重新渲染时自动恢复 check、高亮和原 ref。

`tfoot`、ArtTable footer、Ant Design summary/footer 与 Arco summary/footer 被视为非业务行，不参与悬停、单选、批量选择或滚动恢复，避免总计行与第一条数据共享 `data-rowindex`。

批量计数和“取消当前页已选”基于 `tableKey + pageIndex` 的行快照元数据，不依赖当前 DOM。虚拟滚动回收顶部节点后，已加入数量仍然准确，也可以一次取消当前页所有已加入快照。

选择去重同时维护正反向索引：`refToRenderedRowIdentity` 用于检测节点复用，`renderedRowIdentityToRef` 用于在 DOM WeakMap 因虚拟重绘丢失时阻止重复加入。因此先单选若干行再全选当前页，只会补充尚未加入的指纹。

表格组以首次加入时间编号：最早为表格 1，之后递增。展示层按新到旧排序，因此顶部表格编号最大。有表头与无表头表格遵循完全相同的排序规则；后续向已有表格追加行不改变编号。

表格 check/bar 固定使用 999 层级：高于普通列表、固定列和页面内容，低于通常从 1000 起的 Drawer/Modal。该策略不监听站点浮层事件，避免引入全局 MutationObserver 和框架耦合。

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

### 截图与多模态发送

内容脚本请求 background 调用 `chrome.tabs.captureVisibleTab`，以 JPEG 82% 质量捕获当前标签页可见区域。捕获前会临时隐藏 Chat、表格 checkbox、批量栏和选中高亮，避免扩展自身 UI 进入截图。区域截图先用顶层指针遮罩收集 CSS 像素坐标，再按捕获图片尺寸与 viewport 的比例使用 Canvas 裁剪，因此兼容 iframe、canvas 和跨域渲染内容。选区仅限当前可见区域，Esc 或过小选区会取消。图片只保存在 `STATE.contexts`，不写入浏览器存储。

发送时，表格仍作为 system 文本上下文；最近最多 4 张启用截图附加到最新 user message，使用 OpenAI 兼容的 `image_url` 内容块。客户端为每张图预留保护性 token 预算，但实际视觉 token 由模型供应商决定。模型配置未开启 `supportsImages` 时，Chat 会在请求前阻止发送截图；background 还会再次校验，避免绕过 UI。

### 模型配置与切换

同步设置保存 `models[]` 和 `activeModelId`。每个模型包含稳定 ID、显示名称、Base URL、Model 参数、上下文窗口、输出上限和 `supportsImages`。本地存储使用 `modelApiKeys[modelId]` 保存独立密钥。Chat 只读取脱敏模型列表，并通过 `SET_ACTIVE_MODEL` 修改当前 ID；background 在每次请求开始时重新解析当前模型和对应密钥。

旧版扁平的单模型设置会自动迁移为 ID 为 `default` 的首个模型，原 API Key 同步迁移到 `modelApiKeys.default`。

首次对话只有截图且输入为空时，不执行面向表格的 onboarding 请求，而是聚焦输入框并提示用户描述图片分析目标。

## 5. 存储与隐私

| 存储区 | 数据 | 生命周期 |
|---|---|---|
| `storage.local` | 按模型 ID 保存的 API Key Map | 当前浏览器扩展安装周期 |
| `storage.local` | 技能配置、数据源绑定和页面显示名称 | 当前浏览器扩展安装周期，支持导入导出 |
| `storage.sync` | 模型配置列表、当前模型、UI 位置、启动器开关 | 浏览器账号同步 |
| 页面内存 | 上下文、表格派生视图、对话 | 刷新、跳转或关闭页面时清空 |
| 页面内存 | 技能测试/执行的采集数据、模型结果和继续问记录 | 退出本次全屏技能会话时释放 |
| 页面内存 | 测试/执行时上传的 CSV、TSV、XLSX 解析结果 | 退出本次全屏技能会话时释放，不进入技能配置 |

旧版本同步存储中的 API Key 会在首次读取时迁移到 local，并删除同步副本。

技能配置继续保存在 `web2aiSkills`，页面名称继续保存在 `web2aiSkillPageNames`，因此旧版本和导入文件无需一次性迁移。内容脚本可以直接读取，但新增、修改、删除、导入以及兼容字段补齐必须通过 `MUTATE_SKILLS` 进入 background 单队列。用户编辑会递增单技能 `revision`；保存陈旧草稿时拒绝覆盖并保留草稿。自动学习缺失的业务页签名称只填空值、不覆盖用户或其他页面已有值，也不递增 revision，避免无业务内容变化时制造编辑冲突。

### 启动器与表格能力开关

`launcherHidden` 保存在 `storage.sync`，是 Chat 启动器与表格选择能力的统一开关。顶层 frame 渲染启动器和聊天浮层；所有 frame 都监听该状态并启用或停用各自的表格交互。关闭启动器时，行 checkbox、批量栏、高亮和 pinned 标记全部隐藏，但上下文快照保留。点击浏览器工具栏中的扩展图标会发送 `SHOW_LAUNCHER`，清除隐藏状态并恢复当前 tab 所有 frame 的表格 UI。

`STATE.launcherVisible` 是页面运行时镜像，`launcherHidden` 是跨 frame 的持久化事实。所有修改持久化值的路径都必须同步更新当前 frame，避免等待异步 `storage.onChanged` 才更新 UI。

上下文不再写入 `storage.session`，因此没有固定 50 条存储上限，也不存在恢复后的 DOM 对应关系失效问题。发送量仍受 token 预算控制；大量数据的 UI 性能应通过折叠或虚拟列表解决，而不是静默淘汰上下文。

## 6. 跨页表格

跨页选择保存当前表格作用域与内容摘要，触发下一页后使用 `MutationObserver` 优先检测 DOM 变化，并以低频轮询兜底。DOM 整体替换后会重新定位 live table、清理断开的行引用并更新锚点。

该功能属于启发式自动化，不保证适配所有服务端分页、虚拟滚动和 canvas 表格。新增框架适配时应保持通用 ARIA fallback。

## 7. 错误与安全边界

- AI 返回 Markdown 在生成 HTML 前先转义原始 HTML，并限制链接为 HTTP(S)。
- 模型返回的常见 HTML 会先按白名单转换为 Markdown；危险节点被删除、未知标签只保留文本、非 HTTP(S) 链接降级为纯文字，转换结果仍须经过统一 HTML 转义。
- 网页上下文在 prompt 中标记为不可信数据，不能完全消除提示注入风险。
- 流式请求断开会取消对应 `AbortController`。
- 首个 token 之前的网络失败最多自动重试一次；收到任何内容后不再整请求重试，而是保留部分回答并标记连接中断。
- API 错误目前会显示部分服务端响应；后续应增加脱敏和结构化错误码。
- AI、技能和采集诊断默认关闭；诊断仅记录长度、数量、页码和 DOM 特征，不记录提示词、数据行或密钥。静态回归禁止在 `src` 中保留 `.log/.txt` 调试产物。
- 生产 Manifest 使用 `<all_urls>` 自动注入轻量加载器，确保网页右侧入口在打开或刷新页面后直接可用；自定义 AI API 请求也由该 host 权限覆盖。

## 8. 后续优化路线

### P0：可靠性

- 为部分回答增加显式“继续生成”操作；当前已经避免整请求重试。
- 扩充真实 Chrome E2E，增加跨域 iframe 授权、真实 Ant/Arco 页面和网络断流模拟。

### P1：表格身份

- 允许用户为无业务 row key 的表格配置主键列。
- 为跨页任务持久化来源页、行 key 和去重摘要。

### P1：模型兼容

- 当前请求不发送 `temperature`、`max_tokens` 等可选生成参数，由模型服务使用默认值；后续如需精确控制，再按供应商分别适配参数名、错误格式和流式事件。
- 支持供应商专用 tokenizer，显示估算值和实际 usage。
- 增加超时、429/5xx 指数退避和并发限制。

### P2：权限与性能

- 如果未来重新提供按站点启用模式，需要同时设计一个始终可发现的启用入口；当前优先保证网页右侧入口零操作可见。
- 对大型页面减少全局 selector 扫描，统一使用作用域内 MutationObserver。
- 表格 DOM、表头和分页工具已经从 `table.js` 抽离；后续只有在行选择 UI 继续增长时再拆 checkbox、批量栏和 pinned overlay，不为缩短文件继续扩大改动面。

## 9. 测试

运行：

```bash
npm test
```

当前单元测试覆盖分组与时间编号、固定表头关联、adapter/rowKey、HTML/ARIA 行语义、分页器作用域、技能数据源 DOM 恢复、模块无环边界、上下文隔离、token 预算、SSE chunk 边界、onboarding、Markdown/CSV 导出、模型新增草稿、技能导入去重、虚拟滚动规则、采集完成语义、技能 mutation/revision、旧版与新版 frame/表格定位、工作台会话状态、运行时文件装载，以及单表/多表请求分区、空单元格对齐、预算公平分配和数据完整性判断。静态回归负责全部源文件语法、Manifest 入口、调试日志、demo HTML 结构和关键导出检查。真实 Chrome E2E 还覆盖技能新建、修改、跨页多数据源持久化、测试全部载入、“满意并保存”、执行全部载入、临时 CSV/XLSX 和每个数据源条数展示。

## 10. 技能数据源与执行

### 工作台模块边界

`overlay.js` 只保留 Chat、技能目录、模型切换和 Shadow DOM 外壳。全屏技能工作台按职责拆为四层：`skill-workspace-state.js` 保存兼容现有 `STATE.skillTest` 形状的纯状态规则；`skill-workspace-controller.js` 负责采集、模型提交、停止、保存和继续问；`skill-workspace-view.js` 保留原 DOM class/id 并绑定控制器动作；`skill-workspace-style.js` 保存工作台专用样式。`skill-runtime-file-source.js` 单独负责会话级文件选择和解析结果适配。

控制器不导入 `overlay.js`，而由 overlay 初始化时注入同步和节流渲染函数，避免循环依赖。跨 frame 采集进度由 `main.js` 直接交给控制器；控制器只在 collectionId 匹配当前会话时更新状态。此次拆分不改变 `STATE.skillTest` 字段、background 消息类型、存储 schema、DOM class/id 或旧版数据兼容路径。

技能支持 1–5 个数据源，可以来自同一页面的不同表格，也可以来自多个业务页面。配置保存在 `chrome.storage.local`；每个数据源独立保存稳定 ID、顶层页面、目标 frame、CSS selector、候选序号、字段指纹和绑定时的显示名称。旧版单数据源技能在读取时兼容为 `sources[0]`。

创建和修改统一在 Chat 的技能 Tab 中完成。跨页选择期间 background 保存发起方并向业务页面广播选择状态，选中表格后把结果送回原 Chat 草稿。第一次添加和主动“重新选择”都按本次明确选择记录快照；查看、校验、测试和执行等非编辑流程不自动修改数据源名称。

选择数据源时 background 将选择命令广播到已打开业务页面的所有 frame，用户可切换页面点击目标表格，结果再返回原技能编辑页。新版绑定在原有顶层页面、frame URL、selector、候选序号和字段指纹之外，增量保存 frame 祖先路径提示、selector 强度、组件类型和父容器签名。frame 路径只在同 URL 多 frame 时缩小候选；弱 selector 与候选序号冲突或存在多个候选时返回“位置不明确”，不自动串绑。包含稳定 ID 的 selector 在表格顺序变化时仍保持权威，避免错误回退到旧序号。组件和容器变化当前只产生诊断提示，不阻止已明确定位的数据源。字段校验继续采用严格相等；旧数据没有 `locatorVersion` 时完整保留原先“frame URL + selector 优先、序号回退”的行为。旧版迁移生成的数据源强制继承技能原始页面，不能根据 frame 地址扩散页面归属。

技能配置分析方法后可进入全屏测试模式，并复用 Chat 的模型配置、流式请求和 Markdown 渲染。测试与执行共用 `skill-request-model.js`：客户分析方法保持原文，每个数据源按配置顺序生成独立标题、来源、字段和 Markdown 表格，不增加结论、列表或分析过程等输出要求。请求预算根据当前模型 `contextWindow`、`maxOutputTokens`、分析方法和保护性预留动态计算，再按数据源平均分配；单个大表截断时会标注实际提交行数，不能让靠后的数据源整体消失。

请求组装完成后，运行时把实际发送文本保存为当前会话的 `submittedPrompt` 快照。“查看提交内容”直接展示该快照并允许复制，不根据当前 UI 状态重新拼装，因此即使用户随后修改分析方法、添加或移除临时文件，仍能核对最近一次真实请求。开始下一次测试或执行时清空旧快照，新请求完成组装后替换。

分析结果框直接由工作台会话状态派生阶段反馈：`loading` 显示“正在采集数据...”；`submitting` 和 `analyzing` 显示“已经提交给大模型，正在等待模型返回...”。运行中提示使用独立强调样式，最终模型结果仍沿用 Markdown 正文样式。该映射集中在 `skill-workspace-state.js`，测试与执行视图不得各自维护不同文案。

测试模式以一次全屏会话为缓存边界：只有所有数据源均已载入才允许复用；缺少任意一个数据源时会重新采集。执行模式每次点击“执行技能”都会采集最新数据，“重新分析”只复用本次执行已经完整载入的数据。

保存后的技能会在对应业务数据源上方注入可换行的“技能列表：”横条。点击“执行”先进入全屏执行页，用户再次点击“执行技能”后才开始采集和模型调用。每个数据源 Tab 显示采集中累计条数或完成后的总条数；首次回答后可以继续提问，后续请求携带初次分析及已完成问答。

数据源读取采用可观察、可停止的分页采集会话。采集器逐页识别 Ant Design、Arco、ArtTable、通用虚拟滚动容器以及 iframe 文档级滚动，按约 75% 可视高度推进，等待渲染变化后按整行指纹去重。整行指纹同时承担虚拟列表重叠窗口去重，当前不能简单移除；代价是没有业务 row key 时，完全相同的真实重复行仍可能合并。若当前 frame 无法识别出可操作的滚动容器，但表格存在虚拟化迹象，则回退为 `scrollIntoView` 驱动的保守采集模式，并在每页首次读取前先把表格对齐到顶部，避免从中间已渲染区域开始采集。分页点击统一要求单次激活，避免一次翻页被站点处理两次而跳页。每个数据源限制为 30 页、1000 行，两者任一到达即停止。到达末页或无更多数据记为完整；用户明确设置的页数、30 页保护上限或 1000 行保护上限记为“有界完整”，允许按请求范围提交；用户停止、采集失败和页变化超时分别记为取消、失败和结果不确定，均不提交。进度从数据所在 frame 转发到顶层执行页；每页结束恢复滚动顶部，整个任务结束后恢复业务分页第一页。当前仍不支持 canvas 表格。

表格稳定检测由 `table-pagination-dom.js` 提供参数化策略。普通 `table.js` 跨页选择继续使用原有两秒级最低等待，避免改变已发布的人工选择兼容行为；技能采集器使用独立快速参数，连续比较当前渲染行的内容摘要，并在 Ant/Arco loading 或 `aria-busy` 存在时暂停稳定计数。快速页面可在数百毫秒内继续，内容持续更新的慢页面则等待到稳定或沿用原硬超时。该优化不改变 75% 滚动步长、两次无新增停止、完整性分类或页面恢复规则。

测试和执行都在用户点击开始后逐个预检数据源分页器。检测到多页时要求输入 0–30，默认值为 1；0 表示全部，为兼容旧版仍接受“全部”文本，全部采集仍受 30 页上限约束。页数解析集中在 `skill-collection-model.js`，并同时受页面已知总页数约束。取消页数选择属于可重试的用户中止：清除当前数据源的 loading/collection 状态，不提交模型，工作台保持打开并展示取消原因。目标应用内页面已经关闭时，后台不会用当前页面的相似表格兜底，而会打开保存的页面地址；只有确认页面身份、结构和数据均正确后才写入会话。扩展自动创建的浏览器 Tab 必须等采集结果写入测试或执行状态后才能关闭。

多数据源采用按请求范围的严格完整性策略：只有每个数据源的 `completeForRequest` 都不为 `false` 才组装并提交模型。新版网页采集显式返回该字段；旧版缓存或运行时文件没有该字段时继续按原逻辑兼容。任意数据源未完成、位置不明确、页面无法打开、结构更新被拒绝、采集被终止或结果不确定时，本次不会把不完整数据提交给模型，界面会指出未完成的数据源并保留已采到的预览数据。

### 运行时文件数据源

测试和执行全屏页面允许用户上传 CSV、TSV 或 XLSX。`spreadsheet-file.js` 完全在浏览器内解析文件：分隔文本支持引号、嵌入分隔符和空单元格；XLSX 通过 ZIP 中央目录、浏览器原生 `DecompressionStream` 和 XML 读取工作簿、共享字符串及缓存单元格值，不加载远程脚本。Excel 包含多个工作表时，本次选择其中一个作为独立数据源。

运行时文件数据源标记为 `runtimeOnly: true`、`sourceType: "file"`，并直接携带与网页采集一致的 `headers/rows/rowCount/totalRowCount`。网页采集重置只处理持久化网页数据源，不会清空本次上传文件；请求装配会明确标注文件名和工作表。文件数据源不参与技能创建、修改、页面归属、结构校验、技能导入导出或 `chrome.storage` 写入。退出全屏会话即释放；测试会话中的文件不会进入随后新开的执行会话。

第一版限制为每次最多 5 个临时文件、单文件 10MB、单工作表 10,000 行/500 列/1,000,000 单元格。XLSX ZIP 单 entry 解压后不超过 32MB，全部 entry 累计不超过 64MB，并校验中央目录、本地条目边界和 XML 解析错误。第一行作为表头，空表头生成“列N”。不支持旧二进制 `.xls`、密码保护工作簿、宏和外部链接刷新；公式使用文件中已有的缓存结果。

采集完成后，测试页和执行页的数据源预览对本次内存中的完整采集结果进行分页，每页展示 10 条。预览页码与业务表格页码相互独立，切换预览不会再次翻动业务表格，也不会重新发起模型请求。
