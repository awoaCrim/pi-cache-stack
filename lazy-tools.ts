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
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ALWAYS_ACTIVE, type LazyToolsConfig } from "./config.ts";

export const PROXY_TOOL_NAME = "lazy";

interface LazyToolsState {
  pi: ExtensionAPI;
  alwaysActive: Set<string>;
  /** Tools the LLM has activated this session (beyond alwaysActive). */
  activated: Set<string>;
  /** All tool names currently registered (snapshot, refreshed lazily). */
  knownTools: Map<string, ToolInfo>;
}

function createState(pi: ExtensionAPI, cfg: LazyToolsConfig): LazyToolsState {
  // Merge configured always-active tools with the defaults rather than replacing
  // them: a config like {"alwaysActive": ["bash"]} must not silently drop
  // read/write/edit, otherwise the model loses its core file tools.
  const configured = cfg.alwaysActive && cfg.alwaysActive.length > 0 ? cfg.alwaysActive : [];
  const alwaysActive = new Set([...DEFAULT_ALWAYS_ACTIVE, ...configured]);
  return { pi, alwaysActive, activated: new Set(), knownTools: new Map() };
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
  if (lazyTools.length > 0) {
    lines.push(`Lazily activated this session: ${lazyTools.join(", ")}`);
  }
  lines.push(`Request-body cost: ${formatBytes(activeBytes)} active / ${formatBytes(totalBytes)} total (${totalBytes > 0 ? Math.round((activeBytes / totalBytes) * 100) : 0}%)`);
  lines.push(`Use lazy({ search: "..." }) to find tools, lazy({ activate: ["name"] }) to enable one.`);
  return lines.join("\n");
}

function findMatchingTools(state: LazyToolsState, query: string): ToolInfo[] {
  const q = query.toLowerCase();
  return [...state.knownTools.values()]
    .filter((tool) => !state.alwaysActive.has(tool.name))
    .filter((tool) => {
      if (!q) return true;
      return (
        tool.name.toLowerCase().includes(q) ||
        (tool.description ?? "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => estimateToolBytes(b) - estimateToolBytes(a));
}

function activateTools(state: LazyToolsState, names: string[]): { activated: string[]; missing: string[] } {
  const activated: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const normalized = name.trim();
    if (!normalized) continue;
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
  return { activated, missing };
}

function applyActiveTools(state: LazyToolsState): void {
  // The proxy tool must always stay active so the LLM can re-discover tools.
  // Defensive: keep the proxy even if getAllTools() ever stops listing it.
  const active = [...new Set([PROXY_TOOL_NAME, ...state.alwaysActive, ...state.activated])];
  const known = new Set(state.knownTools.keys());
  const valid = active.filter((name) => known.has(name) || name === PROXY_TOOL_NAME);
  state.pi.setActiveTools(valid);
}

function buildToolResult(state: LazyToolsState, text: string): AgentToolResult {
  return {
    content: [{ type: "text", text }],
    details: { state: { alwaysActive: [...state.alwaysActive], activated: [...state.activated] } },
  } as AgentToolResult;
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
      "Lazy-load gateway for tools. Pi keeps a small always-active tool set active; larger tools are deactivated to shrink the request body. Use lazy({}) for status, lazy({ search: \"query\" }) to find a tool, or lazy({ activate: [\"name\"] }) to enable tools for the rest of the session. Activating takes effect on the next agent turn.",
    promptSnippet: "Discover and activate lazy-loaded tools",
    promptGuidelines: [
      "If a tool you need is not available, call lazy({ search: \"...\" }) to find it.",
      "Activate a tool with lazy({ activate: [\"name\"] }); it becomes available on the next turn.",
      "Keep the always-active set small to save tokens in the request body.",
    ],
    parameters: {
      ...Type.Object({
        search: Type.Optional(Type.String({ description: "Search deactivated tools by name or description; omit to list all" })),
        activate: Type.Optional(Type.Array(Type.String({ description: "Tool names to activate for this session" }))),
        reset: Type.Optional(Type.Boolean({ description: "Reset to only the always-active tool set (removes lazy activations)" })),
      }),
      // 显式 required 数组:全可选 schema 会被 TypeBox 省略 required 键,OpenAI
      // Responses 系上游会把缺失的 required 转成 null 并拒绝("Invalid schema
      // for function 'lazy': None is not of type 'array'")。
      required: [],
    },
    async execute(
      _toolCallId: string,
      params: { search?: string; activate?: string[]; reset?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      if (!getCfg().enabled) {
        return { content: [{ type: "text", text: DISABLED_TEXT }] } as AgentToolResult;
      }
      const state = ensureState();
      if (params.reset) {
        state.activated.clear();
        applyActiveTools(state);
        return buildToolResult(state, buildStatusText(state));
      }
      if (params.activate && params.activate.length > 0) {
        const { activated, missing } = activateTools(state, params.activate);
        const parts: string[] = [];
        if (activated.length > 0) {
          parts.push(`Activated: ${activated.join(", ")} (available next turn)`);
        } else {
          parts.push("Nothing new activated.");
        }
        if (missing.length > 0) {
          parts.push(`Unknown tool names (not registered): ${missing.join(", ")}`);
          const known = [...state.knownTools.values()].map((t) => t.name).join(", ");
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
    handler: async (args: string | undefined, ctx: { hasUI: boolean; ui: { notify: (msg: string, level?: string) => void } }) => {
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
        const { activated, missing } = activateTools(state, names);
        msg = activated.length > 0
          ? `Activated: ${activated.join(", ")} (next turn)`
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
      if (!getCfg().enabled) return;
      // 幂等:session_start 可能重复触发(startup/resume/reload 各路径),重复应用无副作用。
      if (!state) {
        state = createState(pi, getCfg());
      }
      refreshKnownTools(state);
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
