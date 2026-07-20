/** @fileoverview 插件自定义对话框，避免浏览器原生弹窗显示“域名 + 显示”。 */

function showDialog({ title = "提示", message, inputValue = null, textValue = null, confirmText = "确定", cancelText = "取消" }) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.dataset.web2aiUi = "dialog";
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "2147483647" });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .mask { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15,23,42,.38); font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }
        .dialog { width: min(${textValue === null ? "360px" : "900px"}, calc(100vw - 40px)); max-height: calc(100vh - 40px); overflow: hidden; border-radius: 13px; background: #fff; box-shadow: 0 20px 60px rgba(15,23,42,.3); }
        .title { padding: 13px 16px 10px; color: #111827; font-size: 14px; font-weight: 650; border-bottom: 1px solid rgba(0,0,0,.07); }
        .body { padding: 16px; color: #334155; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
        input { width: 100%; height: 34px; box-sizing: border-box; margin-top: 12px; padding: 0 9px; border: 1px solid rgba(0,0,0,.18); border-radius: 8px; outline: none; font-size: 13px; }
        input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
        textarea { width: 100%; height: min(65vh, 620px); box-sizing: border-box; margin-top: 10px; padding: 10px; resize: vertical; border: 1px solid rgba(0,0,0,.18); border-radius: 8px; background: #f8fafc; color: #1e293b; outline: none; font: 12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space: pre; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; }
        button { height: 30px; padding: 0 13px; border: 1px solid rgba(0,0,0,.13); border-radius: 8px; background: #fff; color: #111827; cursor: pointer; }
        button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
      </style>
      <div class="mask" role="dialog" aria-modal="true" aria-labelledby="title">
        <div class="dialog">
          <div class="title" id="title"></div>
          <div class="body"><div class="message"></div>${textValue !== null ? '<textarea readonly spellcheck="false"></textarea>' : inputValue === null ? "" : '<input type="text" />'}</div>
          <div class="actions"><button class="cancel"></button><button class="primary confirm"></button></div>
        </div>
      </div>`;
    shadow.querySelector(".title").textContent = String(title || "提示");
    shadow.querySelector(".message").textContent = String(message || "");
    shadow.querySelector(".cancel").textContent = cancelText;
    shadow.querySelector(".confirm").textContent = confirmText;
    const input = shadow.querySelector("input");
    const textarea = shadow.querySelector("textarea");
    if (input) input.value = String(inputValue ?? "");
    if (textarea) textarea.value = String(textValue ?? "");
    let finished = false;
    const finish = (confirmed) => {
      if (finished) return;
      finished = true;
      const value = input?.value ?? "";
      host.remove();
      resolve(inputValue === null ? confirmed : (confirmed ? value : null));
    };
    shadow.querySelector(".cancel").addEventListener("click", () => finish(false));
    shadow.querySelector(".confirm").addEventListener("click", () => finish(true));
    const mask = shadow.querySelector(".mask");
    let pointerStartedOnMask = false;
    // 文本拖选可能从 input 开始、在遮罩区域松开。不能只根据最终 click
    // 的 target 关闭弹窗；只有完整点击都发生在遮罩空白处才视为取消。
    mask.addEventListener("pointerdown", (event) => {
      pointerStartedOnMask = event.target === mask;
    });
    mask.addEventListener("pointerup", (event) => {
      const shouldClose = pointerStartedOnMask && event.target === mask;
      pointerStartedOnMask = false;
      if (shouldClose) finish(false);
    });
    mask.addEventListener("pointercancel", () => { pointerStartedOnMask = false; });
    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter") finish(true);
    });
    document.documentElement.appendChild(host);
    setTimeout(() => (input || textarea || shadow.querySelector(".confirm"))?.focus(), 0);
  });
}

const showConfirmDialog = (message, options = {}) => showDialog({ message, ...options });
const showPromptDialog = (message, inputValue, options = {}) => showDialog({ message, inputValue, ...options });
const showTextDialog = (title, textValue, options = {}) => showDialog({ title, textValue, ...options });

export { showConfirmDialog, showPromptDialog, showTextDialog };
