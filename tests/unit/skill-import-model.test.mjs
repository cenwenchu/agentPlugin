import test from "node:test";
import assert from "node:assert/strict";
import { skillContentFingerprint } from "../../src/content/skill-import-model.js";

function skill(overrides = {}) {
  return {
    id: "skill-a",
    name: "订单分析",
    createdAt: 1,
    analysisMethod: { description: "分析异常订单" },
    sources: [{
      id: "source-a",
      pageKey: "https://example.com/orders",
      frameUrl: "https://example.com/orders",
      selector: ".orders",
      tableIndex: 0,
      headers: ["订单号", "SKU 信息"]
    }],
    ...overrides
  };
}

test("ignores skill IDs, names and timestamps when checking import duplicates", () => {
  const first = skill();
  const second = skill({ id: "skill-b", name: "另一个名称", createdAt: 999 });
  second.sources = [{ ...first.sources[0], id: "source-b" }];
  assert.equal(skillContentFingerprint(first), skillContentFingerprint(second));
});

test("treats changed analysis methods or source structures as new skills", () => {
  const original = skill();
  assert.notEqual(
    skillContentFingerprint(original),
    skillContentFingerprint(skill({ analysisMethod: { description: "分析高风险订单" } }))
  );
  assert.notEqual(
    skillContentFingerprint(original),
    skillContentFingerprint(skill({ sources: [{ ...original.sources[0], headers: ["SKU信息", "订单号"] }] }))
  );
});

test("normalizes header layout whitespace but preserves multi-source order", () => {
  const first = skill();
  const whitespaceOnly = skill({ sources: [{ ...first.sources[0], headers: ["订单号", "SKU信息"] }] });
  assert.equal(skillContentFingerprint(first), skillContentFingerprint(whitespaceOnly));
  const secondSource = { ...first.sources[0], pageKey: "https://example.com/refunds", selector: ".refunds" };
  assert.notEqual(
    skillContentFingerprint(skill({ sources: [first.sources[0], secondSource] })),
    skillContentFingerprint(skill({ sources: [secondSource, first.sources[0]] }))
  );
});

test("distinguishes versioned bindings in same-url sibling frames", () => {
  const first = skill();
  first.sources = [{
    ...first.sources[0],
    locatorVersion: 2,
    framePathHint: [{ url: "https://example.com/orders", sameUrlIndex: 0 }]
  }];
  const second = skill();
  second.sources = [{
    ...first.sources[0],
    framePathHint: [{ url: "https://example.com/orders", sameUrlIndex: 1 }]
  }];
  assert.notEqual(skillContentFingerprint(first), skillContentFingerprint(second));
});

test("keeps legacy table-analysis fingerprint output byte-for-byte stable", () => {
  const legacy = skill();
  assert.equal(
    skillContentFingerprint(legacy),
    JSON.stringify({
      sources: [{
        locatorVersion: 0,
        pageKey: "https://example.com/orders",
        frameUrl: "https://example.com/orders",
        isTopFrame: false,
        selector: ".orders",
        selectorStrength: "",
        tableIndex: 0,
        framePathHint: [],
        componentType: "",
        containerSignature: "",
        headers: ["订单号", "sku信息"]
      }],
      analysisMethod: "分析异常订单"
    })
  );
});

test("distinguishes derived-column skills by selected columns and output config", () => {
  const first = skill({
    type: "derived-column",
    analysisMethod: { description: "" },
    selectedColumns: [{ header: "订单金额", occurrence: 1 }],
    output: { columnName: "AI结论", maxChars: 200 }
  });
  const second = skill({
    type: "derived-column",
    analysisMethod: { description: "" },
    selectedColumns: [{ header: "订单状态", occurrence: 1 }],
    output: { columnName: "AI结论", maxChars: 200 }
  });
  const third = skill({
    type: "derived-column",
    analysisMethod: { description: "" },
    selectedColumns: [{ header: "订单金额", occurrence: 1 }],
    output: { columnName: "风险结论", maxChars: 200 }
  });
  assert.notEqual(skillContentFingerprint(first), skillContentFingerprint(second));
  assert.notEqual(skillContentFingerprint(first), skillContentFingerprint(third));
});
