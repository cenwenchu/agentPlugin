/**
 * 无 tokenizer 依赖的保守 token 估算，只用于客户端预算保护，不等同于供应商计费 token。
 * 中文/非 ASCII 近似 1 字符 1 token，连续 ASCII 近似 4 字符 1 token。
 */
function estimateTokens(text) {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    tokens += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  for (const char of String(text ?? "")) {
    if (char.codePointAt(0) <= 0x7f) asciiRun++;
    else {
      flushAscii();
      tokens++;
    }
  }
  flushAscii();
  return tokens;
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, message) => {
    const content = message?.content;
    const contentTokens = Array.isArray(content)
      ? content.reduce((partSum, part) => partSum + (part?.type === "text" ? estimateTokens(part.text) : 0), 0)
      : estimateTokens(content);
    return sum + 4 + contentTokens;
  }, 2);
}

function selectContextsWithinTokenBudget(contexts, tokenBudget) {
  const selected = [];
  const selectedRefs = new Set();
  let remaining = Math.max(0, tokenBudget);
  const add = (context) => {
    if (!context || selectedRefs.has(context.ref || context.id)) return;
    const cost = estimateTokens(context.text) + 24;
    if (cost > remaining) return;
    selected.push(context);
    selectedRefs.add(context.ref || context.id);
    remaining -= cost;
  };

  // Preserve table schema before rows, then favor the newest user-selected items.
  contexts.filter((context) => context.kind === "table-header").forEach(add);
  contexts.filter((context) => context.kind !== "table-header").forEach(add);
  return { contexts: selected, usedTokens: tokenBudget - remaining, remainingTokens: remaining };
}

function calculateContextBudget({ contextWindow, maxOutputTokens, messages, reserveTokens = 512 }) {
  const historyTokens = estimateMessagesTokens(messages);
  const availableTokens = Math.max(0, contextWindow - maxOutputTokens - historyTokens - reserveTokens);
  return { contextWindow, maxOutputTokens, historyTokens, reserveTokens, availableTokens };
}

export { estimateTokens, estimateMessagesTokens, selectContextsWithinTokenBudget, calculateContextBudget };
