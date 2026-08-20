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

export interface LazyToolsModelOverride {
  enabled?: boolean;
  alwaysActive?: string[];
  /** Tools that are registered but must never be active or lazy-activated. */
  disabled?: string[];
  /** List lazy-loadable tool names in the stable system prompt. */
  showCatalogInPrompt?: boolean;
}

export interface LazyToolsConfig extends LazyToolsModelOverride {
  enabled: boolean;
  alwaysActive: string[];
  /** Per-model overrides. Patterns match `provider/model-id`, or just model id when no slash is present. */
  modelOverrides?: Record<string, LazyToolsModelOverride>;
}

export interface EffectiveLazyToolsConfig {
  enabled: boolean;
  alwaysActive: string[];
  disabled: string[];
  showCatalogInPrompt: boolean;
}

export interface ModelIdentity {
  provider: string;
  id: string;
}

export interface CacheStackConfig {
  lazyTools: LazyToolsConfig;
}

export const DEFAULT_CONFIG: CacheStackConfig = {
  lazyTools: {
    enabled: true,
    alwaysActive: DEFAULT_ALWAYS_ACTIVE,
    disabled: [],
    showCatalogInPrompt: true,
    modelOverrides: {},
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeModelOverride(value: unknown): LazyToolsModelOverride | undefined {
  if (!isRecord(value)) return undefined;
  const override: LazyToolsModelOverride = {};
  if (typeof value.enabled === "boolean") override.enabled = value.enabled;
  if (isStringArray(value.alwaysActive)) override.alwaysActive = [...value.alwaysActive];
  if (isStringArray(value.disabled)) override.disabled = [...value.disabled];
  if (typeof value.showCatalogInPrompt === "boolean") {
    override.showCatalogInPrompt = value.showCatalogInPrompt;
  }
  return override;
}

/**
 * Keep malformed user fields from changing the extension's fail-open behavior.
 * JSON parsing errors are handled by loadConfig; invalid field types fall back
 * to the corresponding defaults and invalid model rules are ignored.
 */
function normalizeLazyToolsConfig(value: unknown): LazyToolsConfig {
  const source = isRecord(value) ? value : {};
  const modelOverrides: Record<string, LazyToolsModelOverride> = {};
  if (isRecord(source.modelOverrides)) {
    for (const [pattern, override] of Object.entries(source.modelOverrides)) {
      const normalized = normalizeModelOverride(override);
      if (normalized) modelOverrides[pattern] = normalized;
    }
  }

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.lazyTools.enabled,
    alwaysActive: isStringArray(source.alwaysActive)
      ? [...source.alwaysActive]
      : [...DEFAULT_CONFIG.lazyTools.alwaysActive],
    disabled: isStringArray(source.disabled) ? [...source.disabled] : [],
    showCatalogInPrompt: typeof source.showCatalogInPrompt === "boolean"
      ? source.showCatalogInPrompt
      : true,
    modelOverrides,
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "i");
}

function matchesModel(pattern: string, model: ModelIdentity): boolean {
  const target = pattern.includes("/") ? `${model.provider}/${model.id}` : model.id;
  return globToRegExp(pattern).test(target);
}

/**
 * Resolve the effective lazy policy for one model. Matching overrides are
 * applied in JSON declaration order, so later matches win per field.
 */
export function resolveLazyToolsConfig(
  config: LazyToolsConfig,
  model?: ModelIdentity,
): EffectiveLazyToolsConfig {
  const base = normalizeLazyToolsConfig(config);
  let resolved: EffectiveLazyToolsConfig = {
    enabled: base.enabled ?? DEFAULT_CONFIG.lazyTools.enabled,
    alwaysActive: base.alwaysActive ?? [...DEFAULT_CONFIG.lazyTools.alwaysActive],
    disabled: base.disabled ?? [],
    showCatalogInPrompt: base.showCatalogInPrompt ?? true,
  };
  if (!model) return resolved;

  for (const [pattern, override] of Object.entries(base.modelOverrides ?? {})) {
    if (!matchesModel(pattern, model)) continue;
    resolved = deepMerge(resolved, override) as EffectiveLazyToolsConfig;
  }
  return resolved;
}

/** 读取配置;文件缺失/损坏时回退默认值(不抛异常,不阻塞扩展加载)。 */
export function loadConfig(): CacheStackConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
      const merged = deepMerge(DEFAULT_CONFIG, raw) as Record<string, unknown>;
      return {
        lazyTools: normalizeLazyToolsConfig(merged.lazyTools),
      };
    }
  } catch (err) {
    console.error(`[${EXT_NAME}] failed to load ${CONFIG_PATH}:`, err);
  }
  return {
    lazyTools: normalizeLazyToolsConfig(DEFAULT_CONFIG.lazyTools),
  };
}
