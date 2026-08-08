/**
 * pure.ts — compact 的纯函数模块(无 pi 运行时依赖,便于单测)
 *
 * 内容:消息转文本、OpenAI 工具反序列化(格式探测 + fail-closed)、
 * 最近文件/已加载技能提取、有界文件读取。compact.ts 只负责编排。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import type { CompactConfig } from "./config.ts";

export function contentToText(content: unknown): string {
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

interface OpenAIToolConversion {
  tools: Tool[];
  /** 识别出的工具格式;未知混合格式返回 null(fail-closed)。 */
  format: "chat-completions" | "responses";
}

/**
 * Convert serialized OpenAI-format tools captured from the last normal request
 * back into the pi `Tool[]` shape that streamSimple's `context.tools` expects.
 *
 * 支持两种格式:
 *   - Chat Completions:  `{type:"function", function:{name, description, parameters, strict}}`
 *   - Responses:         `{type:"function", name, description, parameters, strict}`(顶层字段)
 *
 * 规则:
 *   - `type: "custom"`(grammar/Lark 工具)跳过 —— 中继不支持,compact 请求也不应重放;
 *   - 其他未知形状 → 返回 null(fail-closed),调用方回退默认 compact,而不是猜测性回放;
 *   - `strict: true` 反推回 `constrainedSampling`(convertTools 只对 json_schema
 *     约束工具输出 strict:true,不还原会导致 round-trip 降级、请求字节变化)。
 */
export function openAIToolsToPiTools(tools: unknown[]): OpenAIToolConversion | null {
  const result: Tool[] = [];
  let format: OpenAIToolConversion["format"] | undefined;
  for (const raw of tools) {
    const t = raw as {
      type?: string;
      function?: { name?: string; description?: string; parameters?: unknown; strict?: unknown };
      name?: string;
      description?: string;
      parameters?: unknown;
      strict?: unknown;
    };
    if (t?.type === "custom") {
      continue; // grammar tools: skip, keep remaining function tools
    }
    if (t?.type !== "function") {
      return null; // unknown shape: fail closed
    }
    const isCompletionsShape = !!t.function?.name;
    const name = isCompletionsShape ? t.function?.name : t.name;
    if (!name) return null;
    const strict = isCompletionsShape ? t.function?.strict : t.strict;
    const description = isCompletionsShape ? t.function?.description ?? "" : t.description ?? "";
    const parameters = isCompletionsShape ? t.function?.parameters : t.parameters;
    const tool: Tool = {
      name,
      description,
      parameters: (parameters ?? {}) as Tool["parameters"],
    };
    if (strict === true) {
      tool.constrainedSampling = { type: "json_schema", strict: "require" };
    }
    result.push(tool);
    const toolFormat: OpenAIToolConversion["format"] = isCompletionsShape ? "chat-completions" : "responses";
    if (format === undefined) {
      format = toolFormat;
    } else if (format !== toolFormat) {
      return null; // mixed formats: fail closed
    }
  }
  if (format === undefined) {
    // 只有 custom 工具或空数组:无可回放的 function 工具。
    return { tools: result, format: "chat-completions" };
  }
  return { tools: result, format };
}

/**
 * Collect the most recently touched file paths from branch entries, scanning
 * backwards so the newest tool calls win. Mirrors Claude Code's "top N recent
 * files" re-injection: only read/write/edit tool calls with a string `path`
 * argument count.
 */
export function extractRecentFiles(branchEntries: unknown[], maxFiles: number): string[] {
  const seen = new Set<string>();
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
 * Identify skills that were loaded via the `read` tool during the session.
 * Skills live at `<agentDir>/skills/<name>/SKILL.md` (or a custom path ending in
 * SKILL.md). Scan branch entries backwards for read tool calls whose `path` points
 * at a SKILL.md file or a skill directory, and return the SKILL.md file paths
 * (deduped, newest first).
 */
export function extractLoadedSkills(branchEntries: unknown[], maxSkills: number): string[] {
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

export function isSkillFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.endsWith("SKILL.md")) return true;
  // A read inside a skill directory (parent of SKILL.md) also counts.
  return (
    /\/skills\/[^/]+\/.*\.(md|markdown)$/i.test(normalized) ||
    /(^|\/)\.claude\/skills\//.test(normalized) ||
    /(^|\/)(agents\/skills|skills)\//.test(normalized)
  );
}

export function skillLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const m = normalized.match(/([^/]+)\/SKILL\.md$/i);
  return m ? m[1] : normalized.split("/").slice(-2).join("/");
}

/**
 * 有界读取:最多读 maxChars 个字符(按 UTF-8 每字符 4 字节上限取字节数),
 * 避免把超大文件整体读进内存(旧实现 readFileSync 无上限)。
 * 返回截断标记:文件比读取的字节多(或解码后超过 maxChars)视为截断。
 * 调用方负责 existsSync/statSync 前置检查;不可读抛错由调用方 try/catch。
 */
export function readFirstChars(path: string, maxChars: number): { text: string; truncated: boolean } {
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
export function readFileContents(paths: string[], cfg: CompactConfig): string {
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
 * Read skill file contents under a token budget. Returns a text block ready to be
 * appended to the summary, labeling each skill by its directory name.
 */
export function readSkillContents(skillPaths: string[], cfg: CompactConfig): string {
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

/** 提取 compact 请求体元信息(request-logger 落盘用)。 */
export function extractMetaFromMessages(
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
