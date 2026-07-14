function createContextRef() {
  return `CTX_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
}

function isContextRef(ref) {
  return typeof ref === "string" && /^CTX(?:\d+|_[0-9a-f]+_[0-9a-f]+)$/i.test(ref);
}

export { createContextRef, isContextRef };
