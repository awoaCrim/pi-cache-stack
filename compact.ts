/**
 * compact 功能模块(合并自 compact-safe)
 *
 * cache-safe forking compact,让 compact 摘要请求命中服务器端前缀缓存
 * (对标 Claude Code 的 cache-safe forking):
 *
 *  Pi 默认的 compact(compaction.js)把整个对话序列化成 <conversation> 文本塞进
 *  一条独立 user 消息 + 换成专用 SUMMARIZATION_SYSTEM_PROMPT,前缀与正常请求
 *  完全不同,服务器端前缀缓存全部 miss。
 *
 *  本模块通过 session_before_compact 钩子完全接管 compact:
 *    - system prompt 用 ctx.getSystemPrompt()(经 pi 本体的 system_prompt_filter
 *      过滤后与激活集无关,恒等于正常请求的 system → 前缀第 1 段一致;
 *      无需捕获/持久化)
 *    - messages 用 branchEntries 还原的完整历史(sessionEntryToContextMessages + convertToLlm)
 *    - tools 用 before_provider_request 捕获的最后一次正常请求的 tools 数组回放
 *      (持久化到 sidecar,跨 reload/重启兜底)
 *    - 追加一条 user 摘要指令
 *  => 摘要请求的前缀与最后一次正常请求完全一致,服务器端前缀缓存命中,
 *     只有追加的摘要指令是新鲜写入的。
 */

import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { streamSimple, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXT_NAME, type CompactConfig } from "./config.ts";
import { extractPayloadMeta, logRequest } from "./sink.ts";

let loggerWarned = false;

const SUMMARY_INSTRUCTION = `Summarize the conversation above. Produce a concise structured summary that preserves enough detail to continue working without the full history. Include: goals and constraints, what has been done, what is in progress, blockers, key decisions and why, exact file paths/function names/commands/error strings when known, and the next concrete steps. Do not mention the summarization itself.`;

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === "object") {
          const item = c as { type?: string; text?: string; name?: string; arguments?: unknown };
          switch (item.type) {
            case "text":
              return item.text ?? "";
            case "thinking":
              // Drop chain-of-thought from the persisted summary entirely (it is
              // multi-line; a line-based filter would leak the remaining lines).
              return "";
            case "toolCall": {
              const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
              return `[toolCall] ${item.name ?? "tool"}(${args})`;
            }
            default:
              return `[${item.type ?? "unknown"}]`;
          }
        }
        return String(c);
      })
      .join("\n");
  }
  return "";
}

/**
 * Convert serialized OpenAI-format tools (`{type:"function", function:{name,
 * description, parameters, strict}}`) captured from the last normal request back
 * into the pi `Tool[]` shape that streamSimple's `context.tools` expects. The
 * provider re-serializes these through convertTools, producing byte-identical
 * `tools` in the outgoing request (verified: reverse-map + convertTools round
 * trip is byte-identical for the captured 22-tool body). Grammar/`custom` tools
 * are skipped (not supported on this relay).
 *
 * `strict` is faithfully re-derived: convertTools only emits `strict: true`
 * for tools with `constrainedSampling.type === "json_schema"`, so we must
 * re-attach that marker when the captured tool carried `strict: true`; otherwise
 * the round-trip would degrade it to `false` and change the request bytes.
 */
function openAIToolsToPiTools(tools: unknown[]): Tool[] {
  const result: Tool[] = [];
  for (const raw of tools) {
    const t = raw as {
      type?: string;
      function?: { name?: string; description?: string; parameters?: unknown; strict?: unknown };
    };
    if (t?.type !== "function" || !t.function?.name) continue;
    const tool: Tool = {
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: (t.function.parameters ?? {}) as Tool["parameters"],
    };
    if (t.function.strict === true) {
      tool.constrainedSampling = { type: "json_schema", strict: "require" };
    }
    result.push(tool);
  }
  return result;
}

/**
 * Reconstruct the full conversation prefix exactly as the last normal request saw it:
 * all branch entries -> session messages -> LLM messages.
 *
 * This mirrors pi's normal request pipeline (agent-loop.ts streamAssistantResponse):
 *   messages -> transformContext (all extensions' context hooks, e.g. plan-mode
 *   stripping) -> convertToLlm -> provider.transformMessages (aborted/error
 *   skipping + synthetic orphan tool results).
 *
 * Reusing `ctx.transformContext` (the same hook chain the normal request runs)
 * instead of hand-copying its behavior is what keeps the rebuilt prefix aligned
 * with the provider-cached payload. Hand-reimplementing it here would drift
 * whenever pi or an extension adds a new context hook.
 */
function buildConversationPrefix(branchEntries: unknown[], ctx: ExtensionContext): Promise<unknown[]> {
  const allMessages: unknown[] = [];
  for (const entry of branchEntries) {
    const entryMessages = sessionEntryToContextMessages(entry as never);
    if (entryMessages && entryMessages.length > 0) {
      allMessages.push(...entryMessages);
    }
  }
  return ctx
    .transformContext(allMessages as AgentMessage[])
    .then((transformed) => convertToLlm(transformed as AgentMessage[]) as unknown[]);
}

/** 提取 compact 请求体元信息(request-logger 落盘用)。 */
function extractMetaFromMessages(
  messages: unknown[],
  tools: Tool[] | undefined,
  modelId: string,
  maxTokens: number,
): Record<string, number | string> {
  let systemPromptLength: number | undefined;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (first && (first.role === "system" || first.role === "developer") && typeof first.content === "string") {
    systemPromptLength = first.content.length;
  }
  return {
    messageCount: messages.length,
    toolCount: tools?.length ?? 0,
    systemPromptLength: systemPromptLength ?? 0,
    model: modelId,
    maxTokens,
  };
}

/**
 * Collect the most recently touched file paths from branch entries, scanning
 * backwards so the newest tool calls win. Mirrors Claude Code's "top N recent
 * files" re-injection: only read/write/edit tool calls with a string `path`
 * argument count.
 */
function extractRecentFiles(branchEntries: unknown[], maxFiles: number): string[] {  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = branchEntries.length - 1; i >= 0 && result.length < maxFiles; i--) {
    const entry = branchEntries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const tool = block as { type?: string; name?: string; arguments?: { path?: string } } | undefined;
      if (!tool || tool.type !== "toolCall" || typeof tool.name !== "string") continue;
      if (tool.name !== "read" && tool.name !== "write" && tool.name !== "edit") continue;
      const path = tool.arguments?.path;
      if (typeof path !== "string" || path.length === 0 || seen.has(path)) continue;
      seen.add(path);
      result.push(path);
      if (result.length >= maxFiles) break;
    }
  }
  return result;
}

/**
 * 有界读取:最多读 maxChars 个字符(按 UTF-8 每字符 4 字节上限取字节数),
 * 避免把超大文件整体读进内存(旧实现 readFileSync 无上限)。
 * 返回截断标记:文件比读取的字节多(或解码后超过 maxChars)视为截断。
 */
function readFirstChars(path: string, maxChars: number): { text: string; truncated: boolean } {
  const size = statSync(path).size;
  if (size <= 0) return { text: "", truncated: false };
  const bytes = Math.min(size, maxChars * 4);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, read).toString("utf8");
    const truncated = read < size || text.length > maxChars;
    return { text: text.slice(0, maxChars), truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read file contents for the given paths, respecting a total token budget.
 * Files are truncated to `maxCharsPerFile`; the total is capped at `fileTokenBudget`
 * (chars/4 heuristic). Unreadable files are skipped. Returns a text block ready to
 * be appended to the summary.
 */
function readFileContents(paths: string[], cfg: CompactConfig): string {
  const totalBudgetChars = cfg.fileTokenBudget * 4;
  const sections: string[] = [];
  let used = 0;
  for (const p of paths) {
    if (used >= totalBudgetChars) break;
    try {
      if (!existsSync(p)) continue;
      const size = statSync(p).size;
      if (size <= 0) continue;
      const limit = Math.min(cfg.maxCharsPerFile, totalBudgetChars - used);
      const { text, truncated } = readFirstChars(p, limit);
      if (!text) continue;
      used += text.length;
      sections.push(`### ${p}\n${text}${truncated ? "\n[truncated]" : ""}`);
    } catch {
      // unreadable/binary file - skip
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : "";
}

/**
 * Identify skills that were loaded via the `read` tool during the session.
 * Skills live at `<agentDir>/skills/<name>/SKILL.md` (or a custom path ending in
 * SKILL.md). Scan branch entries backwards for read tool calls whose `path` points
 * at a SKILL.md file or a skill directory, and return the SKILL.md file paths
 * (deduped, newest first).
 */
function extractLoadedSkills(branchEntries: unknown[], maxSkills: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = branchEntries.length - 1; i >= 0 && result.length < maxSkills; i--) {
    const entry = branchEntries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const tool = block as { type?: string; name?: string; arguments?: { path?: string } } | undefined;
      if (!tool || tool.type !== "toolCall" || tool.name !== "read") continue;
      const path = tool.arguments?.path;
      if (typeof path !== "string" || path.length === 0 || seen.has(path)) continue;
      if (isSkillFile(path)) {
        seen.add(path);
        result.push(path);
        if (result.length >= maxSkills) break;
      }
    }
  }
  return result;
}

function isSkillFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.endsWith("SKILL.md")) return true;
  // A read inside a skill directory (parent of SKILL.md) also counts.
  return /\/skills\/[^/]+\/.*\.(md|markdown)$/i.test(normalized) ||
    /(^|\/)\.claude\/skills\//.test(normalized) ||
    /(^|\/)(agents\/skills|skills)\//.test(normalized);
}

/**
 * Read skill file contents under a token budget. Returns a text block ready to be
 * appended to the summary, labeling each skill by its directory name.
 */
function readSkillContents(skillPaths: string[], cfg: CompactConfig): string {
  const totalBudgetChars = cfg.skillTokenBudget * 4;
  const sections: string[] = [];
  let used = 0;
  for (const p of skillPaths) {
    if (used >= totalBudgetChars) break;
    try {
      if (!existsSync(p)) continue;
      const size = statSync(p).size;
      if (size <= 0) continue;
      const label = skillLabel(p);
      const limit = totalBudgetChars - used;
      const { text, truncated } = readFirstChars(p, limit);
      if (!text) continue;
      used += text.length;
      sections.push(`### Skill: ${label}\n${text}${truncated ? "\n[truncated]" : ""}`);
    } catch {
      // unreadable - skip
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : "";
}

function skillLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const m = normalized.match(/([^/]+)\/SKILL\.md$/i);
  return m ? m[1] : normalized.split("/").slice(-2).join("/");
}

async function runCacheSafeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  cfg: CompactConfig,
  snapshot: LastRequestSnapshot,
) {
  const { preparation } = event;
  const model = ctx.model;
  if (!model) {
    console.error(`[${EXT_NAME}:compact] no active model, skipping cache-safe compact`);
    return undefined;
  }

  // Reconstruct the exact prefix of the last normal request by replaying pi's
  // normal request pipeline: buildContextEntries -> sessionEntryToContextMessages
  // -> transformContext (all context hooks, incl. plan-mode) -> convertToLlm.
  // The provider (streamSimple) then applies transformMessages (aborted/error
  // skipping, synthetic orphan tool results), exactly as it did for the normal
  // request, so the rebuilt prefix matches the cached payload.
  //
  // buildContextEntries is compaction-aware and is the same source the normal
  // request uses for agent.state.messages, so this does NOT re-inject the
  // compaction summary the way a naive rebuild would.
  let contextEntries: unknown[];
  try {
    contextEntries = ctx.sessionManager.buildContextEntries() as unknown[];
  } catch {
    contextEntries = event.branchEntries as unknown[];
  }
  const prefix = await buildConversationPrefix(contextEntries, ctx);
  if (prefix.length === 0) {
    console.warn(`[${EXT_NAME}:compact] empty conversation prefix, skipping`);
    return undefined;
  }

  // Trim trailing plain-text assistant replies so the rebuilt prefix aligns with
  // the LAST NORMAL REQUEST's body (server-side prefix cache target).
  //
  // A normal request's body always ends with either a tool result or an
  // assistant turn that carries pending tool calls - it never ends with a
  // completed (stop) plain-text reply, because that reply is the OUTPUT of the
  // request and is only appended to the conversation afterwards. When /compact
  // runs, that final reply has already landed in the history, so a naive rebuild
  // would include one more message than any cached request and the prefix cache
  // can never hit. Drop trailing assistant messages that carry no toolCall
  // blocks (i.e. completed replies with nothing pending).
  while (prefix.length > 0) {
    const last = prefix[prefix.length - 1] as { role?: string; content?: unknown; stopReason?: string } | undefined;
    const isPlainReply =
      last?.role === "assistant" &&
      last.stopReason === "stop" &&
      !(Array.isArray(last.content) && last.content.some((b) => (b as { type?: string }).type === "toolCall"));
    if (!isPlainReply) break;
    prefix.pop();
  }
  if (prefix.length === 0) {
    console.warn(`[${EXT_NAME}:compact] empty conversation prefix after trim, skipping`);
    return undefined;
  }

  // system prompt:取当前会话值(经 system_prompt_filter 过滤后与工具激活集
  // 无关,恒等于正常请求发送的 system → 前缀第 1 段逐字节一致)。
  const systemPrompt = ctx.getSystemPrompt();
  if (!cfg.keepSystemPrompt || !systemPrompt) {
    console.warn(`[${EXT_NAME}:compact] keepSystemPrompt disabled or no system prompt, skipping cache-safe compact`);
    return undefined;
  }

  // The relay tokenizes `tools` into the cached prefix, so the compact request
  // MUST send the same tools array as the last normal request or the cache can
  // never hit. Capture them from `before_provider_request` (only normal agent
  // requests fire that hook; the compact request itself calls streamSimple
  // directly and does not loop back). Snapshot is persisted to a sidecar so a
  // reload between the last request and the compact still replays it.
  const capturedTools = snapshot.tools;
  const compactTools: Tool[] | undefined =
    capturedTools && capturedTools.length > 0 ? openAIToolsToPiTools(capturedTools) : undefined;
  if (!compactTools || compactTools.length === 0) {
    console.warn(
      `[${EXT_NAME}:compact] no tools captured from the last request; compact prefix will likely miss the server-side cache`,
    );
  }
  console.info(
    `[${EXT_NAME}:compact] replaying prefix: ${prefix.length} messages (rebuilt via transformContext), ${compactTools?.length ?? 0} tools, system prompt from current session`,
  );

  // Resolve auth for the active model.
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    console.error(`[${EXT_NAME}:compact] failed to resolve auth: ${auth.error}`);
    return undefined;
  }

  // Append the summarization instruction as a fresh user message. Merge in the
  // previous summary (iterative update) and any /compact custom instructions so
  // repeated compacts preserve summary continuity.
  let instruction = SUMMARY_INSTRUCTION;
  if (preparation.previousSummary) {
    instruction += `\n\nAn existing summary from an earlier compaction follows. Preserve still-true details from it and merge in the new conversation above:\n<previous-summary>\n${preparation.previousSummary}\n</previous-summary>`;
  }
  if (event.customInstructions) {
    instruction += `\n\nAdditional focus requested by the user: ${event.customInstructions}`;
  }
  const summarizationMessages = [
    ...prefix,
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: instruction }],
      timestamp: Date.now(),
    },
  ];

  const maxTokens = cfg.maxTokens;
  // Pi 0.84: getApiKeyAndHeaders returns ProviderHeaders with string|null values,
  // where null marks header deletion. Passing null through to streamSimple would
  // override the Authorization header set from apiKey and break the request, so
  // drop null values before forwarding.
  const headers: Record<string, string> = {};
  if (auth.headers) {
    for (const [key, value] of Object.entries(auth.headers)) {
      if (value !== null) headers[key] = value;
    }
  }
  const options: SimpleStreamOptions = {
    maxTokens,
    signal: event.signal,
    apiKey: auth.apiKey,
    headers,
    cacheRetention: "short",
    onPayload: (payload) => {
      try {
        logRequest(ctx.cwd ?? process.cwd(), payload, {
          type: "compact-final",
          ...extractPayloadMeta(payload),
        });
      } catch (err) {
        if (!loggerWarned) {
          loggerWarned = true;
          console.warn(`[${EXT_NAME}:compact] request-logger unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return undefined;
    },
  };
  if (cfg.summaryReasoning && cfg.summaryReasoning !== "off") {
    options.reasoning = cfg.summaryReasoning;
  }

  try {
    // 记录 compact 请求输入到 request-logger(与正常请求同一目录,便于对比)。
    // compact 直连 streamSimple 不走 before_provider_request,这里手动调用 sink。
    try {
      const payloadForLog = {
        model: model.id,
        messages: summarizationMessages,
        tools: compactTools,
        max_tokens: maxTokens,
      };
      logRequest(ctx.cwd ?? process.cwd(), payloadForLog, {
        type: "compact",
        ...extractMetaFromMessages(summarizationMessages, compactTools, model.id, maxTokens),
      });
    } catch (err) {
      console.warn(`[${EXT_NAME}:compact] request-logger unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const stream = streamSimple(model, { systemPrompt, messages: summarizationMessages, tools: compactTools }, options);
    const assistantMessage = await stream.result();
    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      // "aborted" means the user cancelled the summarization; do not commit a
      // compaction that discards the conversation on an interrupted request.
      console.error(`[${EXT_NAME}:compact] summarization ${assistantMessage.stopReason}: ${assistantMessage.errorMessage ?? "unknown"}`);
      return undefined;
    }
    const summary = contentToText(assistantMessage.content).trim();
    if (!summary) {
      console.error(`[${EXT_NAME}:compact] empty summary produced`);
      return undefined;
    }

    // Claude Code-style re-injection: append the content of recently touched
    // files so the compacted context still carries the actual working files,
    // not just a textual summary.
    let finalSummary = summary;
    let injectedFiles: string[] = [];
    if (cfg.injectRecentFiles) {
      const recentFiles = extractRecentFiles(event.branchEntries as unknown[], cfg.maxRecentFiles);
      const fileBlock = readFileContents(recentFiles, cfg);
      if (fileBlock) {
        finalSummary = `${summary}\n\n## Context Files\n${fileBlock}`;
        injectedFiles = recentFiles;
      }
    }

    // Re-inject skills that were actually loaded via read during the session.
    // Pi only puts name/description in the system prompt; the full SKILL.md is
    // read on demand. After compaction that loaded content would be lost unless
    // we embed it into the summary (Claude Code re-injects invoked skills).
    let injectedSkills: string[] = [];
    if (cfg.injectLoadedSkills) {
      const loadedSkills = extractLoadedSkills(event.branchEntries as unknown[], 10);
      const skillBlock = readSkillContents(loadedSkills, cfg);
      if (skillBlock) {
        finalSummary = `${finalSummary}\n\n## Context Skills\n${skillBlock}`;
        injectedSkills = loadedSkills;
      }
    }

    return {
      compaction: {
        summary: finalSummary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage: assistantMessage.usage,
        details: {
          cacheSafe: true,
          prefixMessages: prefix.length,
          injectedFiles,
          injectedSkills,
        },
      },
    };
  } catch (err) {
    console.error(`[${EXT_NAME}:compact] summarization error:`, err);
    return undefined;
  }
}

export interface BeforeProviderRequestEvent {
  payload?: { tools?: unknown[] };
}

/** 最后一次正常请求的 tools 数组快照。system prompt 不捕获(getSystemPrompt 恒稳定)。 */
interface LastRequestSnapshot {
  /** OpenAI-format tools array from the last normal request payload. */
  tools?: unknown[];
  timestamp?: number;
}

/**
 * 快照按 cwd 持久化到 sidecar 文件。原因:/reload 或进程重启后,内存捕获
 * (lastRequestTools)丢失;若用户在重载后未发过消息就直接 /compact,compact
 * 请求的 tools 为空 → 前缀与最后一次正常请求不一致 → 服务器端前缀缓存 miss。
 * sidecar 让跨进程的 compact 也能回放最后一次请求的 tools。
 * (system prompt 经 system_prompt_filter 后恒稳定,不需要持久化。)
 */
const SIDECAR_DIR = join(homedir(), ".pi", "agent");
function sidecarPath(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return join(SIDECAR_DIR, `cache-stack-last-request-${hash}.json`);
}

export interface CompactHooks {
  /** 捕获最后一次正常请求的 tools 数组(仅正常请求触发;compact 请求直连 streamSimple 不回环)。 */
  onBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): undefined;
  onBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<unknown>;
  onReset(): void;
}

export function setupCompact(getCfg: () => CompactConfig): CompactHooks {
  let lastSnapshot: LastRequestSnapshot = {};
  let lastCwd: string | undefined;
  let lastSnapshotJson: string | undefined;

  function loadSnapshot(cwd: string): LastRequestSnapshot {
    if (lastCwd === cwd && lastSnapshotJson !== undefined) {
      // 内存快照(当前进程捕获过请求)
      return lastSnapshot;
    }
    // 跨进程/跨会话兜底:读 sidecar。读失败(首次/损坏)不阻塞 compact。
    try {
      if (existsSync(sidecarPath(cwd))) {
        const snap = JSON.parse(readFileSync(sidecarPath(cwd), "utf8")) as LastRequestSnapshot;
        lastCwd = cwd;
        lastSnapshot = snap;
        return snap;
      }
    } catch {
      // 忽略损坏的 sidecar
    }
    return {};
  }

  function saveSnapshot(payload: BeforeProviderRequestEvent["payload"], cwd: string): void {
    const p = payload as { tools?: unknown[] } | undefined;
    if (p && Array.isArray(p.tools) && p.tools.length > 0) {
      lastSnapshot = {
        tools: p.tools,
        timestamp: Date.now(),
      };
    }
    lastCwd = cwd;
    const json = JSON.stringify(lastSnapshot);
    if (json === lastSnapshotJson) return; // 内容未变,不重复写盘
    lastSnapshotJson = json;
    try {
      writeFileSync(sidecarPath(cwd), json, "utf8");
    } catch {
      // 写盘失败不阻塞请求(内存快照仍可用)
    }
  }

  return {
    onBeforeProviderRequest(event, ctx) {
      if (!getCfg().enabled) return undefined;
      // 防御:runner 未来若不给 handler 传 ctx,降级用进程 cwd(不至于抛异常丢捕获)。
      const cwd = ctx?.cwd ?? process.cwd();
      saveSnapshot(event.payload, cwd);
      return undefined;
    },

    async onBeforeCompact(event, ctx) {
      if (!getCfg().enabled) return undefined;
      return runCacheSafeCompact(event, ctx, getCfg(), loadSnapshot(ctx.cwd));
    },

    onReset() {
      // 只清内存;sidecar 保留,供下次进程恢复后 compact 兜底。
      lastSnapshot = {};
      lastCwd = undefined;
      lastSnapshotJson = undefined;
    },
  };
}
