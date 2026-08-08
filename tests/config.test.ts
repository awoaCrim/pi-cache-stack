import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deepMerge, DEFAULT_CONFIG } from "../config.ts";

describe("config deepMerge", () => {
  it("returns base when override is not a record", () => {
    const base = { a: 1 };
    assert.deepEqual(deepMerge(base, null), base);
    assert.deepEqual(deepMerge(base, "x"), base);
    assert.deepEqual(deepMerge(base, [1]), base);
  });

  it("overrides scalars and replaces arrays wholesale", () => {
    const base = { a: 1, b: [1, 2], nested: { x: 1, y: 2 } };
    const merged = deepMerge(base, { a: 2, b: [3], nested: { x: 9 } }) as typeof base;
    assert.equal(merged.a, 2);
    assert.deepEqual(merged.b, [3]); // array replaced, not merged
    assert.deepEqual(merged.nested, { x: 9, y: 2 }); // nested merged key by key
  });

  it("treats null/undefined override values as unset", () => {
    const base = { a: 1 };
    const merged = deepMerge(base, { a: null, b: undefined }) as typeof base;
    assert.equal(merged.a, 1);
  });

  it("merges nested objects recursively", () => {
    const base = { compact: { enabled: true, maxTokens: 4096, injectRecentFiles: true } };
    const merged = deepMerge(base, { compact: { maxTokens: 2048 } }) as typeof base;
    assert.equal(merged.compact.enabled, true);
    assert.equal(merged.compact.maxTokens, 2048);
    assert.equal(merged.compact.injectRecentFiles, true);
  });

  it("DEFAULT_CONFIG loads through deepMerge against an empty override", () => {
    const merged = deepMerge(DEFAULT_CONFIG, {}) as typeof DEFAULT_CONFIG;
    assert.equal(merged.lazyTools.enabled, true);
    assert.equal(merged.compact.logRequests, true);
    assert.ok(merged.compact.fileTokenBudget < 20000); // budget defaults reduced
  });
});
