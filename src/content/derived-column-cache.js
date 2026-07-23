/**
 * @fileoverview AI自定义列运行期缓存。
 */

const DERIVED_CACHE_PREFIX = "web2aiDerivedCache";
const DEFAULT_DERIVED_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DERIVED_CACHE_MAX_ENTRIES = 2000;
const derivedRuntimeMemoryCache = new Map();

function hasSessionStorage() {
  return Boolean(globalThis.chrome?.storage?.session);
}

function buildDerivedColumnCacheKey(analysisFingerprint = "", rowFingerprint = "") {
  return `${DERIVED_CACHE_PREFIX}:${String(analysisFingerprint || "").trim()}:${String(rowFingerprint || "").trim()}`;
}

function parseDerivedColumnCacheKey(key = "") {
  const prefix = `${DERIVED_CACHE_PREFIX}:`;
  if (!String(key).startsWith(prefix)) return null;
  const parts = String(key).slice(prefix.length).split(":");
  if (parts.length < 2) return null;
  const rowFingerprint = parts.slice(-2).join(":");
  const analysisFingerprint = parts.slice(0, -2).join(":");
  if (!analysisFingerprint || !rowFingerprint) return null;
  return { analysisFingerprint, rowFingerprint };
}

function isExpiredEntry(entry, ttlMs = DEFAULT_DERIVED_CACHE_TTL_MS) {
  const createdAt = Number(entry?.createdAt) || 0;
  return !createdAt || (Date.now() - createdAt > Math.max(60 * 1000, Number(ttlMs) || DEFAULT_DERIVED_CACHE_TTL_MS));
}

function readDerivedMemoryEntry(key = "", ttlMs = DEFAULT_DERIVED_CACHE_TTL_MS) {
  const entry = derivedRuntimeMemoryCache.get(key);
  if (!entry) return null;
  if (isExpiredEntry(entry, ttlMs)) {
    derivedRuntimeMemoryCache.delete(key);
    return null;
  }
  return entry;
}

function writeDerivedMemoryEntry(key = "", entry = null) {
  if (!key || !entry || typeof entry !== "object") return;
  derivedRuntimeMemoryCache.set(key, {
    ...entry,
    createdAt: Number(entry.createdAt) || Date.now()
  });
}

async function readDerivedColumnCacheEntries(
  analysisFingerprint = "",
  rowFingerprints = [],
  { ttlMs = DEFAULT_DERIVED_CACHE_TTL_MS } = {}
) {
  const fingerprints = [...new Set((Array.isArray(rowFingerprints) ? rowFingerprints : []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!analysisFingerprint || !fingerprints.length || !hasSessionStorage()) return new Map();
  const keys = fingerprints.map((rowFingerprint) => buildDerivedColumnCacheKey(analysisFingerprint, rowFingerprint));
  const stored = await chrome.storage.session.get(keys).catch(() => ({}));
  const cached = new Map();
  const expiredKeys = [];
  for (const rowFingerprint of fingerprints) {
    const key = buildDerivedColumnCacheKey(analysisFingerprint, rowFingerprint);
    const memoryEntry = readDerivedMemoryEntry(key, ttlMs);
    if (memoryEntry?.conclusion) {
      cached.set(rowFingerprint, {
        conclusion: String(memoryEntry.conclusion || "").trim(),
        createdAt: Number(memoryEntry.createdAt) || Date.now()
      });
      continue;
    }
    const entry = stored?.[key];
    if (!entry || typeof entry !== "object") continue;
    if (isExpiredEntry(entry, ttlMs)) {
      expiredKeys.push(key);
      derivedRuntimeMemoryCache.delete(key);
      continue;
    }
    const conclusion = String(entry.conclusion || "").trim();
    if (!conclusion) {
      expiredKeys.push(key);
      derivedRuntimeMemoryCache.delete(key);
      continue;
    }
    writeDerivedMemoryEntry(key, entry);
    cached.set(rowFingerprint, {
      conclusion,
      createdAt: Number(entry.createdAt) || Date.now()
    });
  }
  if (expiredKeys.length) chrome.storage.session.remove(expiredKeys).catch(() => void 0);
  return cached;
}

async function pruneDerivedColumnCacheEntries(
  analysisFingerprint = "",
  { maxEntries = DEFAULT_DERIVED_CACHE_MAX_ENTRIES } = {}
) {
  if (!analysisFingerprint || !hasSessionStorage()) return 0;
  const allEntries = await chrome.storage.session.get(null).catch(() => ({}));
  const prefix = `${DERIVED_CACHE_PREFIX}:${analysisFingerprint}:`;
  const matched = Object.entries(allEntries)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({
      key,
      createdAt: Number(value?.createdAt) || 0
    }))
    .sort((left, right) => left.createdAt - right.createdAt);
  const overflow = matched.length - Math.max(1, Number(maxEntries) || DEFAULT_DERIVED_CACHE_MAX_ENTRIES);
  if (overflow <= 0) return 0;
  const keysToDelete = matched.slice(0, overflow).map((item) => item.key);
  if (keysToDelete.length) await chrome.storage.session.remove(keysToDelete).catch(() => void 0);
  return keysToDelete.length;
}

async function removeDerivedColumnCacheEntries(
  analysisFingerprint = ""
) {
  if (!analysisFingerprint) return 0;
  const prefix = `${DERIVED_CACHE_PREFIX}:${analysisFingerprint}:`;
  let removed = 0;
  for (const key of Array.from(derivedRuntimeMemoryCache.keys())) {
    if (!String(key).startsWith(prefix)) continue;
    derivedRuntimeMemoryCache.delete(key);
    removed += 1;
  }
  if (!hasSessionStorage()) return removed;
  const allEntries = await chrome.storage.session.get(null).catch(() => ({}));
  const keysToDelete = Object.keys(allEntries).filter((key) => key.startsWith(prefix));
  if (keysToDelete.length) {
    await chrome.storage.session.remove(keysToDelete).catch(() => void 0);
    removed += keysToDelete.length;
  }
  return removed;
}

async function writeDerivedColumnCacheEntries(
  analysisFingerprint = "",
  entries = [],
  {
    maxEntries = DEFAULT_DERIVED_CACHE_MAX_ENTRIES
  } = {}
) {
  if (!analysisFingerprint || !hasSessionStorage()) return 0;
  const payload = {};
  let count = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rowFingerprint = String(entry?.rowFingerprint || "").trim();
    const conclusion = String(entry?.conclusion || "").trim();
    if (!rowFingerprint || !conclusion) continue;
    payload[buildDerivedColumnCacheKey(analysisFingerprint, rowFingerprint)] = {
      analysisFingerprint,
      rowFingerprint,
      conclusion,
      createdAt: Number(entry?.createdAt) || Date.now()
    };
    writeDerivedMemoryEntry(buildDerivedColumnCacheKey(analysisFingerprint, rowFingerprint), payload[buildDerivedColumnCacheKey(analysisFingerprint, rowFingerprint)]);
    count += 1;
  }
  if (!count) return 0;
  await chrome.storage.session.set(payload).catch(() => void 0);
  await pruneDerivedColumnCacheEntries(analysisFingerprint, { maxEntries });
  return count;
}

export {
  DEFAULT_DERIVED_CACHE_MAX_ENTRIES,
  DEFAULT_DERIVED_CACHE_TTL_MS,
  DERIVED_CACHE_PREFIX,
  buildDerivedColumnCacheKey,
  isExpiredEntry,
  parseDerivedColumnCacheKey,
  pruneDerivedColumnCacheEntries,
  removeDerivedColumnCacheEntries,
  readDerivedColumnCacheEntries,
  writeDerivedColumnCacheEntries
};
