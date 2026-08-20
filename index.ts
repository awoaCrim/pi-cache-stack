/**
 * cache-stack — 缓存优化栈(lazy-tools + stable tool prompt)
 *
 * 让中继(DeepSeek/new-api 等)的服务器端前缀缓存稳定命中,并压缩请求体:
 *
 *   lazy-tools : 按需激活大工具,收缩并稳定请求体 tools[](前缀第 2 段)
 *
 * system prompt 的稳定性(前缀第 1 段)由 pi 本体的 system_prompt_filter
 * 机制保证(需要 fork:见 my-pi 的 registerSystemPromptFilter 实现):
 * 本扩展注册一个过滤器,只把常驻工具的 snippets/guidelines 和完整 lazy
 * 工具名 catalog 放进 system prompt。catalog 不随激活状态变化，因此动态
 * 激活/停用工具不会改变 system prompt → 前缀恒定。
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
import {
  loadConfig,
  resolveLazyToolsConfig,
  type CacheStackConfig,
  type EffectiveLazyToolsConfig,
  type ModelIdentity,
} from "./config.ts";
import {
  buildLazyToolCatalog,
  getAlwaysActiveTools,
  setupLazyTools,
  PROXY_TOOL_NAME,
} from "./lazy-tools.ts";

export default function cacheStack(pi: ExtensionAPI): void {
  // 配置在 session_start 时惰性重载(编辑无需重启);模型切换时重新解析
  // modelOverrides，不需要重启或新建会话。
  let cfg: CacheStackConfig = loadConfig();
  let currentModel: ModelIdentity | undefined;
  let effectiveLazyTools: EffectiveLazyToolsConfig = resolveLazyToolsConfig(cfg.lazyTools);

  const setCurrentModel = (model: ModelIdentity | undefined): void => {
    currentModel = model ? { provider: model.provider, id: model.id } : undefined;
    effectiveLazyTools = resolveLazyToolsConfig(cfg.lazyTools, currentModel);
  };

  const lazyTools = setupLazyTools(pi, () => effectiveLazyTools);

  // system-prompt 过滤器(pi 本体 registerSystemPromptFilter,同步、每次重建
  // prompt 时调用):保留常驻工具的 snippets/guidelines，并附加完整 lazy pool
  // 的稳定名称 catalog。动态激活工具的详细说明仍通过工具 schema / 激活结果
  // 暴露 → system prompt 与激活集无关 → 前缀第 1 段恒定。
  // 防御:旧版 pi(未装含该 API 的 fork)上此方法不存在,跳过并告警。
  const api = pi as ExtensionAPI & {
    registerSystemPromptFilter?(filter: (event: {
      type: string;
      toolNames: string[];
      toolSnippets: Record<string, string>;
      toolGuidelines: Record<string, string[]>;
    }) => {
      toolSnippets?: Record<string, string>;
      toolGuidelines?: string[];
      selectedTools?: string[];
    } | undefined | void): void;
  };
  if (typeof api.registerSystemPromptFilter === "function") {
    api.registerSystemPromptFilter((event) => {
      if (!effectiveLazyTools.enabled) return undefined;
      const disabled = new Set(effectiveLazyTools.disabled ?? []);
      const keep = new Set([PROXY_TOOL_NAME, ...getAlwaysActiveTools(effectiveLazyTools)]);
      const toolSnippets: Record<string, string> = {};
      for (const [name, snippet] of Object.entries(event.toolSnippets)) {
        if (keep.has(name) && !disabled.has(name)) toolSnippets[name] = snippet;
      }
      const toolGuidelines: string[] = [];
      for (const [name, guidelines] of Object.entries(event.toolGuidelines)) {
        if (keep.has(name) && !disabled.has(name)) toolGuidelines.push(...guidelines);
      }
      const lazyCatalog = buildLazyToolCatalog(pi, effectiveLazyTools);
      if (lazyCatalog) toolGuidelines.push(lazyCatalog);

      // selectedTools:让 buildSystemPrompt 的 hasBash/hasGrep 等派生判断与
      // 可见工具一致(隐藏的工具不会留下"幽灵分支"影响 prompt 引导)。
      return {
        toolSnippets,
        toolGuidelines,
        selectedTools: [...keep].filter((n) => event.toolNames.includes(n) && !disabled.has(n)),
      };
    });
  } else {
    console.warn(
      `[cache-stack] registerSystemPromptFilter unavailable — pi build lacks the system-prompt filter API. ` +
        `System prompt will vary with tool activation (prefix cache may miss). Install the fork build from my-pi.`,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    // 每次新会话重载配置；模型规则按当前 ctx.model 解析。
    cfg = loadConfig();
    setCurrentModel(ctx.model);
    // pi 保证 session_start 先于首个 before_agent_start。
    lazyTools.onSessionStart();
  });

  pi.on("model_select", (event) => {
    // 模型切换后立即应用该模型的 lazy policy；激活过的工具只在新 policy
    // 禁用/隐藏它们时才被移除。
    setCurrentModel(event.model);
    lazyTools.onModelChange();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    // 保险:某些启动路径(reload/重启后 resume)session_start 可能没送达扩展。
    // 这里只 reconcile，不清空会话内已激活工具。
    setCurrentModel(ctx.model);
    lazyTools.onBeforeAgentStart();
  });

  pi.on("tool_execution_end", () => {
    lazyTools.onToolExecutionEnd();
  });

  pi.on("session_shutdown", () => {
    lazyTools.onReset();
  });
}
