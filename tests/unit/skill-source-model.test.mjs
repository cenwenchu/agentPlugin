import test from "node:test";
import assert from "node:assert/strict";
import { buildFramePathHint, chooseSourceTableCandidate, selectSourceFrames } from "../../src/content/skill-source-model.js";

const normalize = (url) => String(url || "").replace(/[?#].*$/, "");
const frames = [
  { frameId: 0, parentFrameId: -1, url: "https://example.com/app" },
  { frameId: 2, parentFrameId: 0, url: "https://example.com/table" },
  { frameId: 3, parentFrameId: 0, url: "https://example.com/table" }
];

test("records same-url sibling position in the frame ancestry hint", () => {
  assert.deepEqual(buildFramePathHint(frames, 3, normalize), [
    { url: "https://example.com/app", sameUrlIndex: 0 },
    { url: "https://example.com/table", sameUrlIndex: 1 }
  ]);
});

test("uses an exact versioned frame path without probing a sibling iframe", () => {
  const selected = selectSourceFrames(frames, {
    locatorVersion: 2,
    frameUrl: "https://example.com/table",
    framePathHint: buildFramePathHint(frames, 3, normalize)
  }, normalize);
  assert.deepEqual(selected.frames.map((frame) => frame.frameId), [3]);
  assert.equal(selected.ambiguous, false);
});

test("keeps legacy bindings on frame-url ordering", () => {
  const selected = selectSourceFrames(frames, { frameUrl: "https://example.com/table" }, normalize);
  assert.deepEqual(selected.frames.slice(0, 2).map((frame) => frame.frameId), [2, 3]);
  assert.equal(selected.ambiguous, false);
});

test("reports ambiguity when a new hint disappears and same-url frames remain", () => {
  const selected = selectSourceFrames(frames, {
    locatorVersion: 2,
    frameUrl: "https://example.com/table",
    framePathHint: [
      { url: "https://example.com/app", sameUrlIndex: 0 },
      { url: "https://example.com/table", sameUrlIndex: 9 }
    ]
  }, normalize);
  assert.equal(selected.ambiguous, true);
  assert.deepEqual(selected.frames, []);
});

test("rejects conflicting selector and table-index candidates only for new bindings", () => {
  const selectorTable = {};
  const indexedTable = {};
  assert.equal(chooseSourceTableCandidate({
    locatorVersion: 2, selectorCandidates: [selectorTable], indexedCandidate: indexedTable, selectorStrength: "positional"
  }).ambiguous, true);
  assert.equal(chooseSourceTableCandidate({
    locatorVersion: 2, selectorCandidates: [selectorTable], indexedCandidate: indexedTable, selectorStrength: "stable-id"
  }).candidate, selectorTable, "a unique ID selector remains authoritative when table order changes");
  assert.equal(chooseSourceTableCandidate({
    locatorVersion: 0, selectorCandidates: [selectorTable], indexedCandidate: indexedTable
  }).candidate, selectorTable, "legacy bindings must keep selector-first compatibility");
});
