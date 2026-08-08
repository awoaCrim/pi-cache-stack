import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdHash, extractPayloadMeta, logRequest } from "../sink.ts";

describe("sink cwdHash", () => {
  it("is a stable 12-char sha1 prefix", () => {
    const cwd = "G:\\Users\\admin\\desktop\\code\\my-pi";
    const h = cwdHash(cwd);
    assert.match(h, /^[0-9a-f]{12}$/);
    assert.equal(cwdHash(cwd), h);
    assert.notEqual(cwdHash("G:\\Users\\admin\\desktop\\code\\dnd"), h);
  });
});

describe("sink extractPayloadMeta", () => {
  it("extracts message/tool counts, model, and max tokens", () => {
    const meta = extractPayloadMeta({
      model: "gpt-test",
      messages: [{ role: "system", content: "abc" }, { role: "user", content: "hi" }],
      tools: [{}, {}],
      max_tokens: 4096,
    });
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.toolCount, 2);
    assert.equal(meta.model, "gpt-test");
    assert.equal(meta.maxTokens, 4096);
    assert.equal(meta.systemPromptLength, 3);
  });

  it("handles empty payloads", () => {
    const meta = extractPayloadMeta({});
    assert.equal(meta.messageCount, undefined);
    assert.equal(meta.toolCount, undefined);
  });
});

describe("sink logRequest", () => {
  it("writes the payload doc under <home>/.pi/agent/requests/<cwd-hash>/", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const cwd = "G:\\Users\\admin\\desktop\\code\\my-pi";
      logRequest(cwd, { model: "test", messages: [], tools: [] }, {
        type: "compact",
        model: "test",
        messageCount: 0,
        toolCount: 0,
      });
      const dir = join(home, ".pi", "agent", "requests", cwdHash(cwd));
      const files = readdirSync(dir);
      assert.equal(files.length, 1);
      const doc = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
      assert.equal(doc.meta.type, "compact");
      assert.equal(doc.payload.model, "test");
      // 非 Windows 平台验证 0o600;Windows 忽略 POSIX 权限位。
      if (process.platform !== "win32") {
        assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
