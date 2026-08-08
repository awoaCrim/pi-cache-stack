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
 *
 * 能力降级(官方 pi 或缺失 fork API 时):
 *   transformContext / buildContextEntries / getSystemPrompt 缺失 → 告警并
 *   回退默认 compact;工具格式未知 → fail-closed 回退;只有全部条件成立才
 *   在 details 里标记 cacheSafe: true。
 */

import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { streamSimple, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool, Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXT_NAME, type CompactConfig } from "./config.ts";
import {
  contentToText,
  extractMetaFromMessages,
  extractRecentFiles,
  extractLoadedSkills,
  openAIToolsToPiTools,
  readFileContents,
  readSkillContents,
} from "./pure.ts";
import { extractPayloadMeta, logRequest } from "./sink.ts";

let loggerWarned = false;

const SUMMARY_INSTRUCTION = `Summarize the conversation above. Produce a concise structured summary that preserves enough detail to continue working without the full history. Include: goals and constraints, what has been done, what is in progress, blockers, key decisions and why, exact file paths/function names/commands/error strings when known, and the next concrete steps. Do not mention the summarization itself.`;

/** fork 能力探测:0.84.x 官方包已有 transformContext/getSystemPrompt,
 *  registerSystemPromptFilter 是 my-pi fork 独有(index.ts 已防御)。这里再兜一层,
 *  任一缺失都回退默认 compact 而不是带病执行。 */
function forkCapabilities(ctx: ExtensionContext): {
  transformContext: boolean;
  buildContextEntries: boolean;
  getSystemPrompt: boolean;
  modelRegistryAuth: boolean;
} {
  const forkCtx = ctx as ExtensionContext & {
    transformContext?: (messages: unknown[]) => Promise<unknown[]>;
    getSystemPrompt?: () => string;
  };
  return {
    transformContext: typeof forkCtx.transformContext === "function",
    buildContextEntries: typeof ctx.sessionManager?.buildContextEntries === "function",
    getSystemPrompt: typeof forkCtx.getSystemPrompt === "function",
    modelRegistryAuth: typeof ctx.modelRegistry?.getApiKeyAndHeaders === "function",
  };
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
 *
 * 约束:不要在 context hook 内再次调用 transformContext(重入/重复处理风险),
 * 这是 pi API 的使用约定,扩展自身遵守即可。
 */
function buildConversationPrefix(branchEntries: unknown[], ctx: ExtensionContext): Promise<unknown[]> {
  const allMessages: unknown[] = [];
  for (const entry of branchEntries) {
    const entryMessages = sessionEntryToContextMessages(entry as never);
    if (entryMessages && entryMessages.length > 0) {
      allMessages.push(...entryMessages);
    }
  }
  const forkCtx = ctx as ExtensionContext & { transformContext?: (messages: unknown[]) => Promise<unknown[]> };
  const transform = forkCtx.transformContext ?? ((messages: unknown[]) => Promise.resolve(messages));
  return transform(allMessages as AgentMessage[]).then((transformed) => convertToLlm(transformed as AgentMessage[]) as unknown[]);
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

  // 能力探测:任一 fork API 缺失 → 告警并回退默认 compact(不标 cacheSafe)。
  const capabilities = forkCapabilities(ctx);
  if (!capabilities.transformContext || !capabilities.buildContextEntries || !capabilities.getSystemPrompt) {
    console.warn(
      `[${EXT_NAME}:compact] missing capabilities (transformContext=${capabilities.transformContext}, ` +
        `buildContextEntries=${capabilities.buildContextEntries}, getSystemPrompt=${capabilities.getSystemPrompt}); ` +
        `falling back to default compact`,
    );
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
  const forkCtx = ctx as ExtensionContext & { getSystemPrompt?: () => string };
  const systemPrompt = forkCtx.getSystemPrompt?.() ?? "";
  if (!cfg.keepSystemPrompt || !systemPrompt) {
    console.warn(`[${EXT_NAME}:compact] keepSystemPrompt disabled or no system prompt, skipping cache-safe compact`);
    return undefined;
  }

  // The relay tokenizes `tools` into the cached prefix, so the compact request
  // MUST send the same tools array as the last normal request or the cache can
  // never hit. Capture them from `before_provider_request` (only normal agent
  // requests fire that hook; the compact request itself calls streamSimple
  // directly and does not loop back). Snapshot is persisted to a sidecar keyed
  // by cwd + model id, so a reload between the last request and the compact
  // still replays it and two models in one cwd never cross-contaminate.
  const capturedTools = snapshot.tools;
  let compactTools: Tool[] | undefined;
  let toolsFormat: string | undefined;
  let toolsFailClosed = false;
  if (capturedTools && capturedTools.length > 0) {
    const converted = openAIToolsToPiTools(capturedTools);
    if (converted === null) {
      // 未知/混合工具格式:fail-closed,回退默认 compact,不猜测性回放。
      toolsFailClosed = true;
    } else {
      compactTools = converted.tools;
      toolsFormat = converted.format;
    }
  }
  if (toolsFailClosed) {
    console.warn(
      `[${EXT_NAME}:compact] captured tools use an unknown or mixed format; failing closed and falling back to default compact`,
    );
    return undefined;
  }
  if (!compactTools || compactTools.length === 0) {
    console.warn(
      `[${EXT_NAME}:compact] no tools captured from the last request; compact prefix will likely miss the server-side cache`,
    );
  }
  console.info(
    `[${EXT_NAME}:compact] replaying prefix: ${prefix.length} messages (rebuilt via transformContext), ` +
      `${compactTools?.length ?? 0} tools (${toolsFormat ?? "none"}), system prompt from current session`,
  );

  // Resolve auth for the active model.
  if (!capabilities.modelRegistryAuth) {
    console.warn(`[${EXT_NAME}:compact] modelRegistry.getApiKeyAndHeaders unavailable; falling back to default compact`);
    return undefined;
  }
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
  const summarizationMessages: Message[] = [
    ...(prefix as Message[]),
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: instruction }],
      timestamp: Date.now(),
    } as Message,
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
    // 复用 normal 请求的会话 ID:new-api 等中继靠 x-client-request-id /
    // x-session-affinity 把同一会话路由到同一个缓存副本。compact 直连
    // streamSimple 若不传 sessionId,请求就缺少亲和头,前缀再对齐也会漂到
    // 别的缓存副本导致 miss。
    sessionId: ctx.sessionManager.getSessionId(),
    ...(cfg.logRequests
      ? {
          onPayload: (payload: unknown) => {
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
        }
      : {}),
  };
  if (cfg.summaryReasoning && cfg.summaryReasoning !== "off") {
    options.reasoning = cfg.summaryReasoning;
  }

  try {
    // 记录 compact 请求输入到 request-logger(与正常请求同一目录,便于对比)。
    // compact 直连 streamSimple 不走 before_provider_request,这里手动调用 sink。
    if (cfg.logRequests) {
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
    // not just a textual summary. 注意:回注会把文件内容/命令输出等持久化进
    // 摘要,扩大敏感数据与仓库内 prompt injection 内容的留存范围——预算默认值
    // 已调低,也可用 injectRecentFiles/injectLoadedSkills 关闭。
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

    // 只有全部条件成立才标记 cacheSafe:true(前缀对齐 + 工具可回放 + 摘要成功)。
    const cacheSafe = compactTools !== undefined && compactTools.length > 0 && prefix.length > 0;
    return {
      compaction: {
        summary: finalSummary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage: assistantMessage.usage,
        details: {
          cacheSafe,
          ...(cacheSafe ? {} : { cacheMissReason: "no tools captured from the last request" }),
          prefixMessages: prefix.length,
          toolsFormat,
          cacheReadTokens: assistantMessage.usage?.cacheRead ?? 0,
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
  type: "before_provider_request";
  payload: unknown;
}

/** 最后一次正常请求的 tools 数组快照。system prompt 不捕获(getSystemPrompt 恒稳定)。 */
interface LastRequestSnapshot {
  /** OpenAI-format tools array from the last normal request payload. */
  tools?: unknown[];
  /** 快照所属模型 id(sidecar 键的一部分,防止同 cwd 不同模型串用)。 */
  model?: string;
  timestamp?: number;
}

/**
 * 快照按 cwd + model id 持久化到 sidecar 文件。原因:/reload 或进程重启后,内存捕获
 * (lastRequestTools)丢失;若用户在重载后未发过消息就直接 /compact,compact
 * 请求的 tools 为空 → 前缀与最后一次正常请求不一致 → 服务器端前缀缓存 miss。
 * sidecar 让跨进程的 compact 也能回放最后一次请求的 tools。
 * (system prompt 经 system_prompt_filter 后恒稳定,不需要持久化。)
 *
 * 注意:同一 cwd 的两个 pi 进程仍会竞争同一 sidecar 文件(最后写入者胜),
 * 但键含模型 id,不同模型互不污染;这是尽力而为的兜底,非强一致。
 */
const SIDECAR_DIR = join(homedir(), ".pi", "agent");
function sidecarPath(cwd: string, model: string): string {
  const cwdHash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  const modelHash = createHash("sha1").update(model).digest("hex").slice(0, 8);
  return join(SIDECAR_DIR, `cache-stack-last-request-${cwdHash}-${modelHash}.json`);
}

export interface CompactHooks {
  /** 捕获最后一次正常请求的 tools 数组(仅正常请求触发;compact 请求直连 streamSimple 不回环)。 */
  onBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): undefined;
  onBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<unknown>;
  onReset(): void;
}

export function setupCompact(getCfg: () => CompactConfig): CompactHooks {
  let lastSnapshot: LastRequestSnapshot = {};
  /** 内存缓存键:`${cwd}\u0000${model}`。 */
  let lastKey: string | undefined;
  /** tools 内容 JSON(不含 timestamp),用于去重:tools 未变就不写盘。 */
  let lastToolsJson: string | undefined;

  function loadSnapshot(cwd: string, model: string): LastRequestSnapshot {
    const key = `${cwd}\u0000${model}`;
    if (lastKey === key && lastToolsJson !== undefined) {
      // 内存快照(当前进程捕获过该 cwd+model 的请求)
      return lastSnapshot;
    }
    // 跨进程/跨会话兜底:读 sidecar。读失败(首次/损坏)不阻塞 compact。
    try {
      if (existsSync(sidecarPath(cwd, model))) {
        const snap = JSON.parse(readFileSync(sidecarPath(cwd, model), "utf8")) as LastRequestSnapshot;
        lastKey = key;
        lastSnapshot = snap;
        lastToolsJson = JSON.stringify(snap.tools ?? null);
        return snap;
      }
    } catch {
      // 忽略损坏的 sidecar
    }
    return {};
  }

  function saveSnapshot(payload: BeforeProviderRequestEvent["payload"], cwd: string, model: string): void {
    const p = payload as { tools?: unknown[] } | undefined;
    if (!p || !Array.isArray(p.tools)) return; // 形状不符不捕获
    // 显式空 tools(如全量工具被禁用)清除旧快照:不能拿上一个模型/会话的
    // 旧工具去回放,否则缓存必然 miss 且回放内容错误。
    const next: LastRequestSnapshot = p.tools.length > 0 ? { tools: p.tools, model, timestamp: Date.now() } : { model };
    const toolsJson = JSON.stringify(next.tools ?? null);
    lastKey = `${cwd}\u0000${model}`;
    if (toolsJson === lastToolsJson) return; // tools 未变,不重复写盘(timestamp 不计入比较)
    lastToolsJson = toolsJson;
    lastSnapshot = next;
    try {
      if (next.tools) {
        writeFileSync(sidecarPath(cwd, model), JSON.stringify(next), "utf8");
      } else {
        // 清掉陈旧的 sidecar,避免下次进程读到旧工具
        try {
          unlinkSync(sidecarPath(cwd, model));
        } catch {
          // 文件不存在,无需处理
        }
      }
    } catch {
      // 写盘失败不阻塞请求(内存快照仍可用)
    }
  }

  return {
    onBeforeProviderRequest(event, ctx) {
      if (!getCfg().enabled) return undefined;
      // 防御:runner 未来若不给 handler 传 ctx,降级用进程 cwd(不至于抛异常丢捕获)。
      const cwd = ctx?.cwd ?? process.cwd();
      const payload = event.payload as { tools?: unknown[]; model?: string } | undefined;
      const model = payload?.model ?? (ctx as { model?: { id?: string } } | undefined)?.model?.id ?? "unknown";
      saveSnapshot(payload, cwd, model);
      return undefined;
    },

    async onBeforeCompact(event, ctx) {
      if (!getCfg().enabled) return undefined;
      const modelId = ctx.model?.id ?? "unknown";
      return runCacheSafeCompact(event, ctx, getCfg(), loadSnapshot(ctx.cwd, modelId));
    },

    onReset() {
      // 只清内存;sidecar 保留,供下次进程恢复后 compact 兜底。
      lastSnapshot = {};
      lastKey = undefined;
      lastToolsJson = undefined;
    },
  };
}
