import test from "node:test";
import assert from "node:assert/strict";
import { createNewModelProfile, DEFAULT_MODEL_PROFILE, validateModelProfile } from "../../src/shared.js";

test("prefills DeepSeek only for the first model", () => {
  const first = createNewModelProfile({ hasProfiles: false, id: "first" });
  assert.equal(first.baseUrl, DEFAULT_MODEL_PROFILE.baseUrl);
  assert.equal(first.model, DEFAULT_MODEL_PROFILE.model);

  const additional = createNewModelProfile({ hasProfiles: true, id: "second" });
  assert.equal(additional.baseUrl, "");
  assert.equal(additional.model, "");
});

test("requires URL and model before saving a model profile", () => {
  assert.deepEqual(validateModelProfile({ baseUrl: "", model: "x" }), { ok: false, field: "baseUrl" });
  assert.deepEqual(validateModelProfile({ baseUrl: "https://example.com/v1", model: "" }), { ok: false, field: "model" });
  assert.deepEqual(validateModelProfile({ baseUrl: "https://example.com/v1", model: "x" }), { ok: true });
});
