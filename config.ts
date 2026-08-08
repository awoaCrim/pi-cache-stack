/**
 * cache-stack — 共享配置与日志前缀
 *
 * 单一配置文件 ~/.pi/agent/cache-stack.json,功能子模块共用。
 * 节级覆盖:缺省节/字段回退默认值(深合并),数组整体替换。
 *
 * 迁移说明:合并前的 lazy-tools.json / compact-safe.json 不再读取。
 * stablePrompt 节已删除:system prompt 稳定性改由 pi 本体的
 * system_prompt_filter 机制实现(见 index.ts 的 registerSystemPromptFilter),
 * 不再需要剥离/冻结。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXT_NAME = "cache-stack";
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "cache-stack.json");

/** 常驻工具集:合并语义 = 默认集 ∪ 配置集(配置只能追加,不能删掉核心工具)。 */
export const DEFAULT_ALWAYS_ACTIVE = [
  "bash",
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
];

export interface LazyToolsConfig {
  enabled: boolean;
  alwaysActive: string[];
}

export interface CompactConfig {
  enabled: boolean;
  maxTokens: number;
  summaryReasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  keepSystemPrompt: boolean;
  /** 把 compact 请求体(messages/tools 全文,可能含敏感内容)落盘到 request-logger 目录。 */
  logRequests: boolean;
  injectRecentFiles: boolean;
  maxRecentFiles: number;
  fileTokenBudget: number;
  maxCharsPerFile: number;
  injectLoadedSkills: boolean;
  skillTokenBudget: number;
}

export interface CacheStackConfig {
  lazyTools: LazyToolsConfig;
  compact: CompactConfig;
}

export const DEFAULT_CONFIG: CacheStackConfig = {
  lazyTools: { enabled: true, alwaysActive: DEFAULT_ALWAYS_ACTIVE },
  compact: {
    enabled: true,
    maxTokens: 4096,
    /**
     * Reasoning level for the summarization request. Defaults to "off": thinking
     * would compete with the summary for the output token budget (at xhigh/"max"
     * on DeepSeek the CoT can consume all 4096 tokens, truncating the summary and
     * silently falling back to Pi's full-price compact). The cache hit only depends
     * on the input prefix, not on reasoning_effort, so lowering it is safe.
     */
    summaryReasoning: "off",
    keepSystemPrompt: true,
    logRequests: true,
    /** Re-inject the content of recently touched files into the summary (Claude Code-style). */
    injectRecentFiles: true,
    /** Max number of distinct files to re-inject. */
    maxRecentFiles: 5,
    /** Total budget (tokens) for re-injected file content. Keep modest: reinjecting too much defeats compaction. */
    fileTokenBudget: 12000,
    /** Max chars read per file (guard against huge files). */
    maxCharsPerFile: 40000,
    /** Re-inject the full content of skills that were loaded via read during the session. */
    injectLoadedSkills: true,
    /** Total budget (tokens) for re-injected skill content. */
    skillTokenBudget: 12000,
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 深合并:override 覆盖 base 的标量/数组(整体替换),嵌套对象逐键合并。
 * null/undefined 视为"未设置"(保持 base),因此顶层或节级 null 不会炸掉后续访问
 * (合并前的平铺写法 {...DEFAULT, ...raw} 对 null spread 同样是安全的)。
 * 导出供测试。
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(override)) return base;
  if (!isRecord(base)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue;
    out[key] = isRecord(value) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** 读取配置;文件缺失/损坏时回退默认值(不抛异常,不阻塞扩展加载)。 */
export function loadConfig(): CacheStackConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<CacheStackConfig>;
      return deepMerge(DEFAULT_CONFIG, raw) as CacheStackConfig;
    }
  } catch (err) {
    console.error(`[${EXT_NAME}] failed to load ${CONFIG_PATH}:`, err);
  }
  return deepMerge(DEFAULT_CONFIG, {}) as CacheStackConfig;
}
