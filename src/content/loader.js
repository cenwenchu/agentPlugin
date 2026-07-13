(function() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
    import(chrome.runtime.getURL('src/content/main.js')).catch(err => {
      const msg = err?.message || String(err);
      if (msg.includes('Extension context invalidated') || msg.includes('context invalidated')) {
        // Extension reloaded — normal, don't pollute console
      } else {
        console.error('[web2ai] Failed to load content script:', err);
      }
    });
  } catch (e) {
    // Extension context invalidated or chrome API unavailable
  }
})();
