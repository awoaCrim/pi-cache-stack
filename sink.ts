/**
 * sink.ts — compact 请求体落盘(vendored from request-logger)
 *
 * 与 request-logger 扩展的 sink 保持同一目录/同一文件名规则/同一文档结构,
 * 便于把正常请求与 compact 请求的字节直接对比。
 *
 * vendor 原因:compact.ts 原先静态导入 "../../request-logger/sink.ts",
 * 依赖兄弟扩展存在;作为独立 git/npm 包安装时该目录不存在,模块加载期
 * 直接失败。这里复制了一份(约 60 行),仓库即可独立安装;若本地同时装有
 * request-logger,两者写同一目录互不冲突(文件名含毫秒时间戳)。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 请求日志根目录(惰性求值,便于测试用 HOME/USERPROFILE 重定向)。 */
function requestsDir(): string {
  return join(homedir(), ".pi", "agent", "requests");
}

let seq = 0;

/** cwd → 安全目录名(12 位 sha1 前缀),与 cache-stack 的 sidecar 命名一致。 */
export function cwdHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

export interface RequestLogMeta {
  /** "normal"、原始 compact 输入("compact")或最终请求体("compact-final") */
  type: "normal" | "compact" | "compact-final";
  timestamp: string;
  model?: string;
  maxTokens?: number;
  messageCount?: number;
  toolCount?: number;
  systemPromptLength?: number;
}

/**
 * 把一个 provider 请求体完整序列化落盘。payload 通常是 OpenAI Chat
 * Completions params(messages/tools/max_tokens 等)。写盘失败不抛异常
 * (不阻塞请求),仅 console 告警。
 */
export function logRequest(
  cwd: string,
  payload: unknown,
  meta: Partial<RequestLogMeta> = {},
): void {
  try {
    const dir = join(requestsDir(), cwdHash(cwd));
    mkdirSync(dir, { recursive: true });
    seq += 1;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const type = meta.type ?? "normal";
    const file = join(dir, `${ts}-${String(seq).padStart(4, "0")}-${type}.json`);
    const doc = {
      meta: {
        type,
        timestamp: meta.timestamp ?? new Date().toISOString(),
        model: meta.model,
        maxTokens: meta.maxTokens,
        messageCount: meta.messageCount,
        toolCount: meta.toolCount,
        systemPromptLength: meta.systemPromptLength,
      },
      payload,
    };
    writeFileSync(file, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
    console.info(
      `[cache-stack:sink] ${type} request body (${meta.messageCount ?? "?"} messages, ${meta.toolCount ?? "?"} tools) -> ${file}`,
    );
  } catch (err) {
    console.warn(`[cache-stack:sink] failed to write request body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 从 OpenAI payload 里抽取元信息(消息数/工具数/system prompt 长度)。 */
export function extractPayloadMeta(payload: unknown): {
  messageCount?: number;
  toolCount?: number;
  systemPromptLength?: number;
  maxTokens?: number;
  model?: string;
} {
  const p = payload as {
    messages?: unknown[];
    tools?: unknown[];
    model?: string;
    max_tokens?: number;
    max_completion_tokens?: number;
  };
  let systemPromptLength: number | undefined;
  const first = p?.messages?.[0] as { role?: string; content?: unknown } | undefined;
  if (first && (first.role === "system" || first.role === "developer") && typeof first.content === "string") {
    systemPromptLength = first.content.length;
  }
  return {
    messageCount: p?.messages?.length,
    toolCount: p?.tools?.length,
    systemPromptLength,
    maxTokens: p?.max_tokens ?? p?.max_completion_tokens,
    model: p?.model,
  };
}
