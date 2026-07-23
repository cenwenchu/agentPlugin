/**
 * @fileoverview 按列分析技能的同步指纹构建。
 */

import {
  DEFAULT_DERIVED_METHOD_VERSION,
  normalizeDerivedColumnSkill,
  normalizeDerivedColumnSelections
} from "./derived-column-model.js";

function normalizeFingerprintText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r?\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function rightRotate(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

function sha256Hex(message) {
  const words = [];
  const encoded = new TextEncoder().encode(String(message ?? ""));
  const bitLength = encoded.length * 8;
  for (let i = 0; i < encoded.length; i++) {
    words[i >> 2] = (words[i >> 2] || 0) | (encoded[i] << (24 - (i % 4) * 8));
  }
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (24 - (bitLength % 32)));
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const schedule = new Array(64);

  for (let offset = 0; offset < words.length; offset += 16) {
    for (let i = 0; i < 16; i++) schedule[i] = words[offset + i] | 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rightRotate(schedule[i - 15], 7) ^ rightRotate(schedule[i - 15], 18) ^ (schedule[i - 15] >>> 3);
      const s1 = rightRotate(schedule[i - 2], 17) ^ rightRotate(schedule[i - 2], 19) ^ (schedule[i - 2] >>> 10);
      schedule[i] = (((schedule[i - 16] + s0) | 0) + ((schedule[i - 7] + s1) | 0)) | 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((((h + S1) | 0) + ch) | 0) + K[i] + schedule[i]) | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  return hash.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

function hashSha256(value) {
  return `sha256:${sha256Hex(value)}`;
}

function canonicalizeSelectedColumnValues(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => normalizeFingerprintText(value))
    .join("\u241f");
}

function buildDerivedColumnRowFingerprint(values = []) {
  return hashSha256(canonicalizeSelectedColumnValues(values));
}

function analysisFingerprintPayload({
  skill = {},
  sourceId = "",
  modelId = "",
  resultSchemaVersion = 1
} = {}) {
  const normalized = normalizeDerivedColumnSkill(skill);
  const method = normalizeFingerprintText(normalized.analysisMethod?.description || "");
  return {
    skillId: String(normalized.id || "").trim(),
    skillRevision: Math.max(0, Number(normalized.revision) || 0),
    sourceId: String(sourceId || normalized.sources?.[0]?.id || normalized.source?.id || "").trim(),
    selectedColumns: normalizeDerivedColumnSelections(normalized.selectedColumns).map((column) => ({
      normalizedHeader: column.normalizedHeader,
      occurrence: column.occurrence
    })),
    analysisMethod: method,
    defaultMethodVersion: normalizeFingerprintText(method)
      ? null
      : Math.max(1, Number(normalized.defaultMethodVersion) || DEFAULT_DERIVED_METHOD_VERSION),
    modelId: String(modelId || "").trim(),
    resultSchemaVersion: Math.max(1, Number(resultSchemaVersion) || 1),
    output: {
      maxChars: Math.max(1, Number(normalized.output?.maxChars) || 0),
      columnName: String(normalized.output?.columnName || "").trim(),
      position: String(normalized.output?.position || "").trim()
    }
  };
}

function buildDerivedColumnAnalysisFingerprint(input = {}) {
  return hashSha256(stableStringify(analysisFingerprintPayload(input)));
}

export {
  analysisFingerprintPayload,
  buildDerivedColumnAnalysisFingerprint,
  buildDerivedColumnRowFingerprint,
  canonicalizeSelectedColumnValues,
  hashSha256,
  normalizeFingerprintText,
  stableStringify
};
