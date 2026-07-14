/**
 * @fileoverview 内容脚本加载器。
 * 通过 manifest.json 的 content_scripts 注入到所有 frame（含 iframe）。
 * 使用动态 import() 加载主逻辑模块 main.js，避免因扩展上下文失效而崩溃。
 */

(function() {
  try {
    // 检查扩展上下文是否有效
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
    import(chrome.runtime.getURL('src/content/main.js')).catch(err => {
      const msg = err?.message || String(err);
      if (msg.includes('Extension context invalidated') || msg.includes('context invalidated')) {
        // 扩展被重新加载 — 正常情况，不污染控制台
      } else {
        console.error('[web2ai] Failed to load content script:', err);
      }
    });
  } catch (e) {
    // 扩展上下文失效或 chrome API 不可用，静默退出
  }
})();
