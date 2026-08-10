import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupLazyTools, PROXY_TOOL_NAME } from "../lazy-tools.ts";
import type { LazyToolsConfig } from "../config.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface FakeTool {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
}

function createFakePi() {
  const registered: Record<string, unknown> = {};
  const known: FakeTool[] = [
    { name: "bash", description: "Run commands", parameters: {}, promptGuidelines: ["prefer compound commands"] },
    { name: "read", description: "Read files", parameters: {}, promptGuidelines: ["use read not cat"] },
    { name: "ctx_search", description: "Search indexed context", parameters: {}, promptGuidelines: ["batch all queries in one call"] },
    { name: "ctx_purge", description: "Purge knowledge base", parameters: {}, promptGuidelines: ["requires confirm: true"] },
  ];
  let active: string[] = [];
  return {
    known,
    get active() {
      return [...active];
    },
    pi: {
      registerTool(def: { name: string }) {
        registered[def.name] = def;
      },
      registerCommand() {},
      getAllTools() {
        return known;
      },
      setActiveTools(names: string[]) {
        active = [...names];
      },
      on() {},
    } as unknown as ExtensionAPI,
    registered,
  };
}

function makeCfg(overrides: Partial<LazyToolsConfig> = {}): LazyToolsConfig {
  return { enabled: true, alwaysActive: [], ...overrides };
}

describe("lazy-tools activation", () => {
  it("applies the always-active set plus the proxy on session start", () => {
    const fake = createFakePi();
    const cfg = { current: makeCfg() };
    const hooks = setupLazyTools(fake.pi, () => cfg.current);
    hooks.onSessionStart();
    assert.ok(fake.active.includes(PROXY_TOOL_NAME));
    assert.ok(fake.active.includes("bash"));
    assert.ok(fake.active.includes("read"));
    assert.ok(!fake.active.includes("ctx_search"));
  });

  it("activates tools via the lazy tool and includes guidance in the result", async () => {
    const fake = createFakePi();
    const cfg = { current: makeCfg() };
    const hooks = setupLazyTools(fake.pi, () => cfg.current);
    hooks.onSessionStart();
    const def = fake.registered[PROXY_TOOL_NAME] as {
      execute: (id: string, params: { activate?: string[] }, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[] }>;
    };
    const result = await def.execute("call_1", { activate: ["ctx_search"] });
    const text = result.content.map((c) => c.text).join("\n");
    assert.ok(text.includes("Activated: ctx_search"));
    assert.ok(text.includes("ctx_search: Search indexed context"));
    assert.ok(text.includes("batch all queries in one call")); // guidance in result
    assert.ok(fake.active.includes("ctx_search"));
  });

  it("matches natural-language capability queries and advertises dedicated web tools before shell workarounds", async () => {
    const fake = createFakePi();
    fake.known.push(
      { name: "web_search", description: "Search the web with source citations", parameters: {} },
      { name: "fetch_content", description: "Fetch HTTP URLs and extract readable content", parameters: {} },
    );
    const cfg = { current: makeCfg() };
    const hooks = setupLazyTools(fake.pi, () => cfg.current);
    hooks.onSessionStart();
    const def = fake.registered[PROXY_TOOL_NAME] as {
      promptGuidelines: string[];
      execute: (id: string, params: { search?: string }, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[] }>;
    };

    const result = await def.execute("call_1", { search: "web search URL fetch HTTP" });
    const text = result.content.map((c) => c.text).join("\n");

    assert.match(text, /web_search/);
    assert.match(text, /fetch_content/);
    assert.ok(def.promptGuidelines.some((guideline) => guideline.includes("dedicated web tool")));
  });

  it("reconciles alwaysActive changes across sessions without restart", () => {
    const fake = createFakePi();
    const cfg = { current: makeCfg({ alwaysActive: ["ctx_search"] }) };
    const hooks = setupLazyTools(fake.pi, () => cfg.current);
    hooks.onSessionStart();
    assert.ok(fake.active.includes("ctx_search"));
    // 配置变更后下一次 session_start 生效
    cfg.current = makeCfg({ alwaysActive: [] });
    hooks.onSessionStart();
    assert.ok(!fake.active.includes("ctx_search"));
    assert.ok(fake.active.includes("bash")); // 默认集仍在
  });

  it("restores the full tool set when enabled flips to false", () => {
    const fake = createFakePi();
    const cfg = { current: makeCfg() };
    const hooks = setupLazyTools(fake.pi, () => cfg.current);
    hooks.onSessionStart();
    assert.ok(!fake.active.includes("ctx_purge"));
    cfg.current = makeCfg({ enabled: false });
    hooks.onSessionStart();
    assert.ok(fake.active.includes("ctx_purge")); // 全量恢复
    assert.ok(fake.active.includes("ctx_search"));
    assert.ok(fake.active.includes("bash"));
  });

  it("is idempotent across repeated session starts", () => {
    const fake = createFakePi();
    const cfg = { current: makeCfg() };
    const hooks = setupLazyTools(fake.pi, () => cfg.current);
    hooks.onSessionStart();
    const first = fake.active;
    hooks.onSessionStart();
    assert.deepEqual(fake.active, first);
  });
});
