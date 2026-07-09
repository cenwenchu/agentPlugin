# Web-to-AI Context Chat (Chrome Extension)

核心能力：

- 选中任意网页文本后，附近出现一个小 icon，点击打开浮层 AI Chat，并把选中内容加入“上下文”
- 右键菜单支持：
  - 添加选中内容到 AI 上下文
  - 添加整页内容到 AI 上下文
  - 打开 AI Chat 浮层
- 浮层内支持持续对话；每次发送会自动带上当前上下文片段
- 支持 DeepSeek（OpenAI 兼容）接口（可配置 Base URL / Model / API Key）
- 支持流式输出（增量展示模型回复）
- 上下文支持“定位/高亮”（selection 场景优先）

## 本地加载

1. 打开 Chrome：`chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目目录：`/Users/cenwenchu/Desktop/Demo/agentPlugin`
5. 进入扩展的「详情」页，打开「扩展程序选项」配置 API Key

默认建议配置：

- Base URL：`https://api.deepseek.com`
- Model：`deepseek-v4-flash`

## 使用

- 在网页上选中一段文本，会出现小图标；点击即可打开浮层并添加上下文
- 或者在网页右键：
  - 「添加选中内容到 AI 上下文」
  - 「添加整页内容到 AI 上下文」
  - 「打开 AI Chat 浮层」

## 文件结构

- manifest.json
- src/background.js：MV3 service worker，负责右键菜单与 AI 请求
- src/contentScript.js：注入网页的浮层 UI + 选中 icon + 上下文/对话状态
- src/options.html / options.js / options.css：配置页（Base URL / Model / API Key）
