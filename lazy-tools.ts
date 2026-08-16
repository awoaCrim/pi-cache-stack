/**
 * lazy-tools 功能模块(合并自 lazy-tools)
 *
 * Pi 默认把全部工具(内置 + 所有扩展)全量塞进请求体 tools[](实测 ~69KB / 17K tokens,
 * 其中 subagent 一个就占 37%)。本模块把这些大工具变成按需激活:
 *
 *  - 常驻集(默认基础小工具)始终激活,请求体很小
 *  - 其余工具通过 `lazy` 代理工具按需激活,激活后整个会话保持
 *  - 常驻集可在 cache-stack.json 的 lazyTools.alwaysActive 追加(合并语义,不能删核心工具)
 *
 * 常驻集之外的所有已注册工具自动视为懒加载(对未来新增扩展同样生效)。
 * lazy 工具名与命令名保持合并前不变(模型已在用)。
 */

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ALWAYS_ACTIVE, type LazyToolsConfig } from "./config.ts";

export const PROXY_TOOL_NAME = "lazy";

interface LazyToolsState {
  pi: ExtensionAPI;
  alwaysActive: Set<string>;
  disabled: Set<string>;
  /** Tools the LLM has activated this session (beyond alwaysActive). */
  activated: Set<string>;
  /** All tool names currently registered (snapshot, refreshed lazily). */
  knownTools: Map<string, ToolInfo>;
}

function createState(pi: ExtensionAPI, cfg: LazyToolsConfig): LazyToolsState {
  // Merge configured always-active tools with the defaults rather than replacing
  // them: a config like {"alwaysActive": ["bash"]} must not silently drop
  // read/write/edit. Explicit disabled entries are removed afterward.
  const configured = cfg.alwaysActive && cfg.alwaysActive.length > 0 ? cfg.alwaysActive : [];
  const disabled = new Set(cfg.disabled ?? []);
  const alwaysActive = new Set(
    [...DEFAULT_ALWAYS_ACTIVE, ...configured].filter((name) => !disabled.has(name)),
  );
  return { pi, alwaysActive, disabled, activated: new Set(), knownTools: new Map() };
}

function refreshKnownTools(state: LazyToolsState): void {
  for (const tool of state.pi.getAllTools()) {
    state.knownTools.set(tool.name, tool);
  }
}

/** Estimate the request-body bytes a tool contributes (description + parameter schema). */
function estimateToolBytes(tool: ToolInfo): number {
  const description = tool.description ?? "";
  let schemaBytes = 0;
  try {
    schemaBytes = JSON.stringify(tool.parameters).length;
  } catch {
    schemaBytes = 0;
  }
  return description.length + schemaBytes;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function describeTool(tool: ToolInfo, alwaysActive: Set<string>): string {
  const lazyMark = alwaysActive.has(tool.name) ? "always" : "lazy";
  return `- ${tool.name} [${lazyMark}] (~${formatBytes(estimateToolBytes(tool))}): ${tool.description}`;
}

function computeSavings(state: LazyToolsState): { activeBytes: number; totalBytes: number } {
  const activeNames = new Set([...state.alwaysActive, ...state.activated]);
  let activeBytes = 0;
  let totalBytes = 0;
  for (const tool of state.knownTools.values()) {
    const bytes = estimateToolBytes(tool);
    totalBytes += bytes;
    if (activeNames.has(tool.name)) activeBytes += bytes;
  }
  return { activeBytes, totalBytes };
}

function buildStatusText(state: LazyToolsState): string {
  const { activeBytes, totalBytes } = computeSavings(state);
  const activeTools = [...new Set([...state.alwaysActive, ...state.activated])];
  const lazyTools = [...state.activated].filter((name) => !state.alwaysActive.has(name));
  const lines: string[] = [];
  lines.push(`Active tools (${activeTools.length}): ${activeTools.join(", ") || "(none)"}`);
  if (state.disabled.size > 0) {
    lines.push(`Disabled tools: ${[...state.disabled].join(", ")}`);
  }
  if (lazyTools.length > 0) {
    lines.push(`Lazily activated this session: ${lazyTools.join(", ")}`);
  }
  lines.push(`Request-body cost: ${formatBytes(activeBytes)} active / ${formatBytes(totalBytes)} total (${totalBytes > 0 ? Math.round((activeBytes / totalBytes) * 100) : 0}%)`);
  lines.push(`Use lazy({ search: "..." }) to find tools, lazy({ activate: ["name"] }) to enable one.`);
  return lines.join("\n");
}

const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "tool", "tools", "with"]);

function searchTerms(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term)),
  )];
}

function findMatchingTools(state: LazyToolsState, query: string): ToolInfo[] {
  const normalizedQuery = query.trim().toLowerCase();
  const terms = searchTerms(normalizedQuery);
  return [...state.knownTools.values()]
    .filter((tool) => !state.alwaysActive.has(tool.name) && !state.disabled.has(tool.name))
    .map((tool) => {
      const name = tool.name.toLowerCase().replace(/[_-]+/g, " ");
      const description = (tool.description ?? "").toLowerCase();
      let score = normalizedQuery && `${name} ${description}`.includes(normalizedQuery) ? terms.length * 4 + 4 : 0;
      for (const term of terms) {
        if (name.includes(term)) score += 4;
        if (description.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter(({ score }) => !normalizedQuery || score > 0)
    .sort((a, b) => b.score - a.score || estimateToolBytes(b.tool) - estimateToolBytes(a.tool))
    .map(({ tool }) => tool);
}

function activateTools(
  state: LazyToolsState,
  names: string[],
): { activated: string[]; missing: string[]; disabled: string[] } {
  const activated: string[] = [];
  const missing: string[] = [];
  const disabled: string[] = [];
  for (const name of names) {
    const normalized = name.trim();
    if (!normalized) continue;
    if (state.disabled.has(normalized)) {
      disabled.push(normalized);
      continue;
    }
    if (!state.knownTools.has(normalized)) {
      missing.push(normalized);
      continue;
    }
    if (state.alwaysActive.has(normalized)) continue; // already always active
    if (state.activated.has(normalized)) continue;
    state.activated.add(normalized);
    activated.push(normalized);
  }
  applyActiveTools(state);
  return { activated, missing, disabled };
}

/**
 * 激活工具的精简 guidance(system_prompt_filter 只保留常驻工具,动态激活的
 * 工具不会出现在 system prompt 里,所以把 description + promptGuidelines
 * 写进 lazy 工具结果,让模型激活后仍能看到该工具的用法)。
 */
function describeActivatedTool(state: LazyToolsState, name: string): string {
  const tool = state.knownTools.get(name);
  if (!tool) return `- ${name}: (unknown tool)`;
  const lines = [`- ${name}: ${tool.description ?? ""}`];
  if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
    for (const g of tool.promptGuidelines) {
      lines.push(`    - ${g}`);
    }
  }
  return lines.join("\n");
}

function applyActiveTools(state: LazyToolsState): void {
  // The proxy tool must always stay active so the LLM can re-discover tools.
  // Defensive: keep the proxy even if getAllTools() ever stops listing it.
  const active = [...new Set([PROXY_TOOL_NAME, ...state.alwaysActive, ...state.activated])];
  const known = new Set(state.knownTools.keys());
  const valid = active.filter(
    (name) => !state.disabled.has(name) && (known.has(name) || name === PROXY_TOOL_NAME),
  );
  state.pi.setActiveTools(valid);
}

function buildToolResult(state: LazyToolsState, text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: { state: { alwaysActive: [...state.alwaysActive], activated: [...state.activated] } },
  } as AgentToolResult<unknown>;
}

export interface LazyToolsHooks {
  onSessionStart(): void;
  onToolExecutionEnd(): void;
  onReset(): void;
}

/**
 * 注册 lazy 工具 + lazy 命令,返回生命周期钩子(index.ts 按管线顺序调用)。
 * lazyTools.enabled=false 时:不接管活跃工具集(保持 Pi 默认全量),lazy 调用给出提示。
 */
export function setupLazyTools(pi: ExtensionAPI, getCfg: () => LazyToolsConfig): LazyToolsHooks {
  let state: LazyToolsState | null = null;

  const ensureState = (): LazyToolsState => {
    if (!state) {
      state = createState(pi, getCfg());
      refreshKnownTools(state);
    }
    return state;
  };

  const DISABLED_TEXT =
    `lazy-tools is disabled (cache-stack.json "lazyTools.enabled": false). ` +
    `All tools stay active, like the pi default.`;

  pi.registerTool({
    name: PROXY_TOOL_NAME,
    label: "Lazy Tool Gateway",
    description:
      "Lazy-load gateway for tools. Pi keeps a small always-active tool set active; larger tools are deactivated to shrink the request body. Use lazy({}) for status, lazy({ search: \"query\" }) to find a tool, or lazy({ activate: [\"name\"] }) to enable tools for the rest of the session. Activating takes effect on the next agent turn. Before falling back to shell code for web research or URL fetching, search for a dedicated tool.",
    promptSnippet: "Discover and activate lazy-loaded tools",
    promptGuidelines: [
      "If a tool you need is not available, call lazy({ search: \"...\" }) to find it.",
      "For web research or HTTP(S) URL fetching, prefer a dedicated web tool over bash, curl, Python, or Node; if none is active, call lazy({ search: \"web\" }) or lazy({ search: \"fetch\" }) first.",
      "Activate a tool with lazy({ activate: [\"name\"] }); it becomes available on the next turn.",
      "Keep the always-active set small to save tokens in the request body.",
    ],
    parameters: {
      ...Type.Object({
        search: Type.Optional(Type.String({ description: "Search deactivated tools by name or description; omit to list all" })),
        activate: Type.Optional(Type.Array(Type.String({ description: "Tool names to activate for this session" }))),
        reset: Type.Optional(Type.Boolean({ description: "Reset to only the always-active tool set (removes lazy activations)" })),
      }),
    },
    async execute(
      _toolCallId: string,
      params: { search?: string; activate?: string[]; reset?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      if (!getCfg().enabled) {
        return { content: [{ type: "text", text: DISABLED_TEXT }] } as AgentToolResult<unknown>;
      }
      const state = ensureState();
      if (params.reset) {
        state.activated.clear();
        applyActiveTools(state);
        return buildToolResult(state, buildStatusText(state));
      }
      if (params.activate && params.activate.length > 0) {
        const { activated, missing, disabled } = activateTools(state, params.activate);
        const parts: string[] = [];
        if (activated.length > 0) {
          parts.push(`Activated: ${activated.join(", ")} (available next turn)`);
          parts.push("");
          parts.push("Tool guidance:");
          for (const name of activated) {
            parts.push(describeActivatedTool(state, name));
          }
        } else {
          parts.push("Nothing new activated.");
        }
        if (disabled.length > 0) {
          parts.push(`Disabled tool names (not activatable): ${disabled.join(", ")}`);
        }
        if (missing.length > 0) {
          parts.push(`Unknown tool names (not registered): ${missing.join(", ")}`);
          const known = [...state.knownTools.values()]
            .filter((tool) => !state.disabled.has(tool.name))
            .map((t) => t.name)
            .join(", ");
          parts.push(`Known tools: ${known}`);
        }
        parts.push("");
        parts.push(buildStatusText(state));
        return buildToolResult(state, parts.join("\n"));
      }
      if (params.search !== undefined) {
        const matches = findMatchingTools(state, params.search ?? "");
        if (matches.length === 0) {
          return buildToolResult(state, `No deactivated tools match "${params.search ?? ""}". ${buildStatusText(state)}`);
        }
        const lines = [`Tools matching "${params.search ?? ""}" (${matches.length}):`, ""];
        for (const tool of matches) {
          lines.push(describeTool(tool, state.alwaysActive));
        }
        lines.push("");
        lines.push("Activate one with lazy({ activate: [\"name\"] }).");
        return buildToolResult(state, lines.join("\n"));
      }
      return buildToolResult(state, buildStatusText(state));
    },
  });

  pi.registerCommand("lazy", {
    description: "Show lazy-tools status: active set, request-body cost, and how to activate tools",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      if (!getCfg().enabled) {
        if (ctx.hasUI) {
          ctx.ui.notify(DISABLED_TEXT, "info");
        } else {
          console.log(DISABLED_TEXT);
        }
        return;
      }
      const state = ensureState();
      const parts = args?.trim()?.split(/\s+/) ?? [];
      const sub = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");
      let msg = buildStatusText(state);
      if (sub === "search" && rest) {
        const matches = findMatchingTools(state, rest);
        msg = matches.length > 0
          ? `Tools matching "${rest}":\n${matches.map((t) => describeTool(t, state.alwaysActive)).join("\n")}`
          : `No deactivated tools match "${rest}".`;
      } else if (sub === "activate" && rest) {
        const names = rest.split(",").map((s) => s.trim()).filter(Boolean);
        const { activated, missing, disabled } = activateTools(state, names);
        msg = activated.length > 0
          ? `Activated: ${activated.join(", ")} (next turn)`
          : disabled.length > 0
            ? `Disabled tools: ${disabled.join(", ")}`
            : missing.length > 0
              ? `Unknown tools: ${missing.join(", ")}`
              : "Nothing new activated.";
      } else if (sub === "reset") {
        state.activated.clear();
        applyActiveTools(state);
        msg = "Reset to always-active set.";
      }
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "info");
      } else {
        console.log(msg);
      }
    },
  });

  return {
    onSessionStart(): void {
      const cfg = getCfg();
      if (!cfg.enabled) {
        // 从启用切到禁用:恢复全量工具集(pi 默认行为),而不是继续停留在裁剪集。
        if (state) {
          refreshKnownTools(state);
          state.activated.clear();
          state.alwaysActive = new Set(state.knownTools.keys());
          applyActiveTools(state);
        }
        // 从未启用过:pi 默认就是全量激活,无需干预。
        return;
      }
      if (!state) {
        state = createState(pi, cfg);
      }
      // reconcile:每次都按当前配置重建 alwaysActive/disabled，并清掉已不存在
      // 或已禁用的会话激活。配置变更在 session_start(以及 index.ts 的 reload)
      // 时生效,无需重启。
      state.disabled = new Set(cfg.disabled ?? []);
      const disabled = state.disabled;
      const configured = cfg.alwaysActive && cfg.alwaysActive.length > 0 ? cfg.alwaysActive : [];
      state.alwaysActive = new Set(
        [...DEFAULT_ALWAYS_ACTIVE, ...configured].filter((name) => !disabled.has(name)),
      );
      state.activated.clear();
      refreshKnownTools(state);
      const known = new Set(state.knownTools.keys());
      for (const name of [...state.activated]) {
        if (!known.has(name)) state.activated.delete(name);
      }
      applyActiveTools(state);
    },
    onToolExecutionEnd(): void {
      if (state) refreshKnownTools(state);
    },
    onReset(): void {
      state = null;
    },
  };
}
