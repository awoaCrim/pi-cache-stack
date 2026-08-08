import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactConfig } from "../config.ts";
import {
  contentToText,
  extractLoadedSkills,
  extractRecentFiles,
  isSkillFile,
  openAIToolsToPiTools,
  readFirstChars,
  readFileContents,
  readSkillContents,
  skillLabel,
} from "../pure.ts";

const cfg: CompactConfig = {
  enabled: true,
  maxTokens: 4096,
  summaryReasoning: "off",
  keepSystemPrompt: true,
  logRequests: true,
  injectRecentFiles: true,
  maxRecentFiles: 5,
  fileTokenBudget: 1000,
  maxCharsPerFile: 500,
  injectLoadedSkills: true,
  skillTokenBudget: 1000,
};

describe("contentToText", () => {
  it("passes strings through", () => {
    assert.equal(contentToText("hi"), "hi");
  });

  it("drops thinking blocks entirely", () => {
    const out = contentToText([
      { type: "text", text: "summary" },
      { type: "thinking", thinking: "secret chain of thought\nline2" },
    ]);
    assert.equal(out.trim(), "summary");
  });

  it("serializes tool calls", () => {
    const out = contentToText([
      { type: "toolCall", name: "read", arguments: { path: "/a" } },
    ]);
    assert.ok(out.includes("[toolCall] read("));
    assert.ok(out.includes('"path":"/a"'));
  });

  it("handles unknown block types", () => {
    assert.equal(contentToText([{ type: "weird" }]), "[weird]");
    assert.equal(contentToText(42), "");
  });
});

describe("openAIToolsToPiTools", () => {
  const completionsTool = {
    type: "function",
    function: {
      name: "lazy",
      description: "gateway",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  };
  const responsesTool = {
    type: "function",
    name: "ctx_search",
    description: "search",
    parameters: { type: "object", properties: {} },
    strict: true,
  };

  it("converts chat-completions shape and re-derives strict", () => {
    const r = openAIToolsToPiTools([completionsTool]);
    assert.equal(r?.format, "chat-completions");
    assert.equal(r?.tools.length, 1);
    assert.equal(r?.tools[0].name, "lazy");
    assert.equal(r?.tools[0].constrainedSampling, undefined);
  });

  it("converts responses shape (top-level fields) and re-derives strict", () => {
    const r = openAIToolsToPiTools([responsesTool]);
    assert.equal(r?.format, "responses");
    assert.equal(r?.tools[0].name, "ctx_search");
    assert.deepEqual(r?.tools[0].constrainedSampling, { type: "json_schema", strict: "require" });
  });

  it("skips custom/grammar tools and keeps function tools", () => {
    const r = openAIToolsToPiTools([{ type: "custom", custom: { name: "g" } }, completionsTool]);
    assert.equal(r?.tools.length, 1);
    assert.equal(r?.tools[0].name, "lazy");
  });

  it("fails closed on unknown shapes", () => {
    assert.equal(openAIToolsToPiTools([{ type: "mystery" }]), null);
    assert.equal(openAIToolsToPiTools([{ type: "function", function: { name: undefined } }]), null);
  });

  it("fails closed on mixed formats", () => {
    assert.equal(openAIToolsToPiTools([completionsTool, responsesTool]), null);
  });

  it("returns empty result for empty or custom-only arrays", () => {
    assert.deepEqual(openAIToolsToPiTools([])?.tools, []);
    assert.deepEqual(openAIToolsToPiTools([{ type: "custom", custom: {} }])?.tools, []);
  });
});

describe("readFirstChars", () => {
  it("reads small files fully without truncation", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-rfc-"));
    try {
      const f = join(dir, "small.txt");
      writeFileSync(f, "你好世界 ".repeat(10));
      const { text, truncated } = readFirstChars(f, 100);
      assert.equal(text.length, 50);
      assert.equal(truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates large files to maxChars", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-rfc-"));
    try {
      const f = join(dir, "big.txt");
      writeFileSync(f, "a".repeat(100000));
      const { text, truncated } = readFirstChars(f, 100);
      assert.equal(text.length, 100);
      assert.equal(truncated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps valid UTF-8 when truncating multibyte content", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-rfc-"));
    try {
      const f = join(dir, "zh.txt");
      writeFileSync(f, "汉".repeat(50000));
      const { text, truncated } = readFirstChars(f, 100);
      assert.equal(text.length, 100);
      assert.equal(truncated, true);
      // 重新编码解码后应仍是有效文本(允许尾部替换字符)
      assert.ok(Buffer.from(text, "utf8").toString("utf8").length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors budgets in readFileContents", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-rfc-"));
    try {
      writeFileSync(join(dir, "a.txt"), "x".repeat(1000));
      writeFileSync(join(dir, "b.txt"), "y".repeat(1000));
      const block = readFileContents([join(dir, "a.txt"), join(dir, "b.txt")], cfg);
      assert.ok(block.includes("[truncated]"));
      assert.ok(block.length <= cfg.fileTokenBudget * 4 + 400); // budget + headers
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skill helpers", () => {
  it("isSkillFile recognizes SKILL.md and skill dirs", () => {
    assert.equal(isSkillFile("C:/x/skills/foo/SKILL.md"), true);
    assert.equal(isSkillFile("C:/x/skills/foo/README.md"), true);
    assert.equal(isSkillFile("C:/x/.claude/skills/bar/SKILL.md"), true);
    assert.equal(isSkillFile("C:/x/src/main.ts"), false);
  });

  it("skillLabel extracts the skill directory name", () => {
    assert.equal(skillLabel("C:/x/skills/foo/SKILL.md"), "foo");
    assert.equal(skillLabel("C:/x/agents/skills/bar/SKILL.md"), "bar");
  });

  it("extractLoadedSkills scans read tool calls for SKILL.md", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "C:/x/skills/foo/SKILL.md" } }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "C:/x/src/main.ts" } }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "C:/x/skills/foo/SKILL.md" } }] } },
    ];
    const skills = extractLoadedSkills(entries, 10);
    assert.deepEqual(skills, ["C:/x/skills/foo/SKILL.md"]);
  });

  it("readSkillContents labels sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-skill-"));
    try {
      const f = join(dir, "SKILL.md");
      writeFileSync(f, "# skill body");
      const block = readSkillContents([f], cfg);
      assert.ok(block.includes("### Skill:"));
      assert.ok(block.includes("# skill body"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractRecentFiles", () => {
  it("collects newest read/write/edit paths, deduped, capped", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/a" } }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "/b" } }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/a" } }] } },
    ];
    // 最新优先:最后一个 entry 的 read /a 最先被收集,然后才是 edit /b
    assert.deepEqual(extractRecentFiles(entries, 5), ["/a", "/b"]);
    assert.deepEqual(extractRecentFiles(entries, 1), ["/a"]);
  });
});
