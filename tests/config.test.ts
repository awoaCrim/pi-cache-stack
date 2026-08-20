import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deepMerge, DEFAULT_CONFIG, resolveLazyToolsConfig } from "../config.ts";

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
    assert.equal(merged.lazyTools.showCatalogInPrompt, true);
    assert.deepEqual(merged.lazyTools.alwaysActive, ["bash", "read", "write", "edit", "ls", "find", "grep"]);
  });
});

describe("resolveLazyToolsConfig", () => {
  it("applies provider/model and bare-id wildcard overrides in declaration order", () => {
    const resolved = resolveLazyToolsConfig(
      {
        enabled: true,
        alwaysActive: ["bash"],
        disabled: [],
        showCatalogInPrompt: true,
        modelOverrides: {
          "gpt-*": { alwaysActive: ["mcp"] },
          "openai/gpt-5.6-*": { enabled: false, showCatalogInPrompt: false },
        },
      },
      { provider: "openai", id: "gpt-5.6-luna" },
    );

    assert.equal(resolved.enabled, false);
    assert.equal(resolved.showCatalogInPrompt, false);
    assert.deepEqual(resolved.alwaysActive, ["mcp"]);
  });

  it("supports single-character wildcards and case-insensitive provider/model matching", () => {
    const resolved = resolveLazyToolsConfig(
      {
        enabled: true,
        alwaysActive: ["bash"],
        disabled: [],
        showCatalogInPrompt: true,
        modelOverrides: {
          "OpenAI/gpt-?.*": { showCatalogInPrompt: false },
        },
      },
      { provider: "openai", id: "gpt-5.x" },
    );

    assert.equal(resolved.showCatalogInPrompt, false);
  });

  it("leaves the base policy unchanged when no model rule matches", () => {
    const resolved = resolveLazyToolsConfig(
      {
        enabled: true,
        alwaysActive: ["bash"],
        disabled: ["danger"],
        showCatalogInPrompt: true,
        modelOverrides: { "anthropic/*": { enabled: false } },
      },
      { provider: "openai", id: "gpt-5.6-luna" },
    );

    assert.equal(resolved.enabled, true);
    assert.deepEqual(resolved.disabled, ["danger"]);
  });

  it("fails open for malformed policy fields", () => {
    const resolved = resolveLazyToolsConfig(
      {
        enabled: "yes",
        alwaysActive: "bash",
        disabled: ["danger"],
        showCatalogInPrompt: "yes",
        modelOverrides: {
          "openai/*": "invalid",
          "gpt-*": { disabled: ["ctx_search"] },
        },
      } as unknown as Parameters<typeof resolveLazyToolsConfig>[0],
      { provider: "openai", id: "gpt-5" },
    );

    assert.equal(resolved.enabled, true);
    assert.deepEqual(resolved.alwaysActive, ["bash", "read", "write", "edit", "ls", "find", "grep"]);
    assert.deepEqual(resolved.disabled, ["ctx_search"]);
    assert.equal(resolved.showCatalogInPrompt, true);
  });
});
