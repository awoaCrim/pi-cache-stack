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
    const base = { lazyTools: { enabled: true, alwaysActive: ["bash"] } };
    const merged = deepMerge(base, { lazyTools: { alwaysActive: ["bash", "ctx_search"] } }) as typeof base;
    assert.equal(merged.lazyTools.enabled, true);
    assert.deepEqual(merged.lazyTools.alwaysActive, ["bash", "ctx_search"]);
  });

  it("DEFAULT_CONFIG loads through deepMerge against an empty override", () => {
    const merged = deepMerge(DEFAULT_CONFIG, {}) as typeof DEFAULT_CONFIG;
    assert.equal(merged.lazyTools.enabled, true);
    assert.deepEqual(merged.lazyTools.alwaysActive, ["bash", "read", "write", "edit", "ls", "find", "grep"]);
  });
});
