/**
 * cache-stack — 共享配置与日志前缀
 *
 * 单一配置文件 ~/.pi/agent/cache-stack.json,功能子模块共用。
 * 节级覆盖:缺省节/字段回退默认值(深合并),数组整体替换。
 *
 * system prompt 稳定性由 pi 本体的 system_prompt_filter 机制实现
 * (见 index.ts 的 registerSystemPromptFilter),不再需要剥离/冻结。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXT_NAME = "cache-stack";
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "cache-stack.json");

/** 常驻工具集:合并语义 = 默认集 ∪ 配置集；disabled 可显式阻止工具激活。 */
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
  /** Tools that are registered but must never be active or lazy-activated. */
  disabled?: string[];
}

export interface CacheStackConfig {
  lazyTools: LazyToolsConfig;
}

export const DEFAULT_CONFIG: CacheStackConfig = {
  lazyTools: { enabled: true, alwaysActive: DEFAULT_ALWAYS_ACTIVE, disabled: [] },
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
