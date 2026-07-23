/**
 * @fileoverview AI自定义列结果解析与校验。
 */

import { normalizeDerivedColumnOutput } from "./derived-column-model.js";

function stripJsonCodeFence(text) {
  const value = String(text ?? "").trim();
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function parseDerivedColumnResultPayload(text) {
  const candidate = stripJsonCodeFence(text);
  return JSON.parse(candidate);
}

function parseDerivedColumnResults({
  text = "",
  expectedFingerprints = [],
  output = {}
} = {}) {
  const normalizedOutput = normalizeDerivedColumnOutput(output);
  const payload = parseDerivedColumnResultPayload(text);
  const items = Array.isArray(payload?.results) ? payload.results : null;
  if (!items) throw new Error("模型返回格式不正确：缺少 results 数组");
  const expected = new Set(expectedFingerprints);
  const mapped = new Map();
  const failures = [];
  for (const item of items) {
    const fingerprint = String(item?.fingerprint || "").trim();
    if (!fingerprint) continue;
    if (!expected.has(fingerprint)) {
      failures.push({ fingerprint, error: "返回了未知 fingerprint" });
      continue;
    }
    if (mapped.has(fingerprint)) {
      failures.push({ fingerprint, error: "返回了重复 fingerprint" });
      continue;
    }
    const rawConclusion = String(item?.conclusion || "").trim();
    if (!rawConclusion) {
      failures.push({ fingerprint, error: "结论为空" });
      continue;
    }
    const conclusion = rawConclusion.slice(0, normalizedOutput.maxChars);
    mapped.set(fingerprint, {
      fingerprint,
      conclusion,
      truncated: conclusion.length < rawConclusion.length
    });
  }
  for (const fingerprint of expected) {
    if (!mapped.has(fingerprint)) failures.push({ fingerprint, error: "缺少结果" });
  }
  return {
    results: Array.from(mapped.values()),
    resultMap: mapped,
    failures
  };
}

export { parseDerivedColumnResultPayload, parseDerivedColumnResults, stripJsonCodeFence };
