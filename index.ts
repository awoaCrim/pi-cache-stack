/**
 * cache-stack — 缓存优化栈(lazy-tools + stable tool prompt)
 *
 * 让中继(DeepSeek/new-api 等)的服务器端前缀缓存稳定命中,并压缩请求体:
 *
 *   lazy-tools : 按需激活大工具,收缩并稳定请求体 tools[](前缀第 2 段)
 *
 * system prompt 的稳定性(前缀第 1 段)由 pi 本体的 system_prompt_filter
 * 机制保证(需要 fork:见 my-pi 的 registerSystemPromptFilter 实现):
 * 本扩展注册一个过滤器,只把常驻工具的 snippets/guidelines 放进 system
 * prompt → 动态激活/停用工具永远不会改变 system prompt → 前缀恒定。
 *
 * 生命周期管线(顺序由 pi 的事件保证,本文件显式编排):
 *   session_start            → 激活常驻工具(lazy-tools)
 *   before_agent_start       → 幂等再应用激活集(某些启动路径漏发 session_start)
 *   tool_execution_end       → 刷新已知工具(lazy-tools)
 *   session_shutdown         → 状态重置
 *
 * 配置 (~/.pi/agent/cache-stack.json):见 config.ts 的 DEFAULT_CONFIG。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, DEFAULT_ALWAYS_ACTIVE, type CacheStackConfig } from "./config.ts";
import { setupLazyTools, PROXY_TOOL_NAME } from "./lazy-tools.ts";

export default function cacheStack(pi: ExtensionAPI): void {
  // 配置在 session_start 时惰性重载(编辑无需重启);其余事件用当前值。
  let cfg: CacheStackConfig = loadConfig();

  const lazyTools = setupLazyTools(pi, () => cfg.lazyTools);

  // system-prompt 过滤器(pi 本体 registerSystemPromptFilter,同步、每次重建
  // prompt 时调用):只保留常驻工具的 snippets/guidelines,动态激活的工具只
  // 通过请求体的 tools 数组暴露 → system prompt 与激活集无关 → 前缀第 1 段
  // 恒定。
  // 防御:旧版 pi(未装含该 API 的 fork)上此方法不存在,跳过并告警。
  const api = pi as ExtensionAPI & {
    registerSystemPromptFilter?(filter: (event: {
      type: string;
      toolNames: string[];
      toolSnippets: Record<string, string>;
      toolGuidelines: Record<string, string[]>;
    }) => { toolSnippets?: Record<string, string>; toolGuidelines?: string[] } | undefined | void): void;
  };
  if (typeof api.registerSystemPromptFilter === "function") {
    api.registerSystemPromptFilter((event) => {
      if (!cfg.lazyTools.enabled) return undefined;
      const keep = new Set([PROXY_TOOL_NAME, ...DEFAULT_ALWAYS_ACTIVE, ...(cfg.lazyTools.alwaysActive ?? [])]);
      const toolSnippets: Record<string, string> = {};
      for (const [name, snippet] of Object.entries(event.toolSnippets)) {
        if (keep.has(name)) toolSnippets[name] = snippet;
      }
      const toolGuidelines: string[] = [];
      for (const [name, guidelines] of Object.entries(event.toolGuidelines)) {
        if (keep.has(name)) toolGuidelines.push(...guidelines);
      }
      // selectedTools:让 buildSystemPrompt 的 hasBash/hasGrep 等派生判断与
      // 可见工具一致(隐藏的工具不会留下"幽灵分支"影响 prompt 引导)。
      return { toolSnippets, toolGuidelines, selectedTools: [...keep].filter((n) => event.toolNames.includes(n)) };
    });
  } else {
    console.warn(
      `[cache-stack] registerSystemPromptFilter unavailable — pi build lacks the system-prompt filter API. ` +
        `System prompt will vary with tool activation (prefix cache may miss). Install the fork build from my-pi.`,
    );
  }

  pi.on("session_start", async () => {
    // 每次新会话重载配置:lazyTools.enabled/alwaysActive 的修改在下一次
    // session_start 生效(配合 lazy-tools 的 reconcile,无需重启)。
    cfg = loadConfig();
    // pi 保证 session_start 先于首个 before_agent_start。
    lazyTools.onSessionStart();
  });

  pi.on("before_agent_start", () => {
    // 保险:某些启动路径(reload/重启后 resume)session_start 可能没送达扩展。
    // before_agent_start 每个 run 必触发,幂等应用激活集,保证请求体 tools[]
    // 恒为 lazy 激活集而不是全量注册集。
    lazyTools.onSessionStart();
  });

  pi.on("tool_execution_end", () => {
    lazyTools.onToolExecutionEnd();
  });

  pi.on("session_shutdown", () => {
    lazyTools.onReset();
  });
}
