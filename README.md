# pi-cache-stack

pi 的缓存优化栈扩展,合并自 compact-safe + lazy-tools:

1. **lazy-tools** — 按需激活大工具,收缩并稳定请求体 `tools[]`(前缀第 2 段)。常驻集之外的所有已注册工具自动视为懒加载,通过 `lazy` 代理工具按需激活,激活后整个会话保持。
2. **compact** — compact 摘要请求回放最后一次正常请求的 `tools[]` + 对话前缀,让中继(DeepSeek/new-api 等)的服务器端前缀缓存稳定命中。

system prompt 的稳定性(前缀第 1 段)由 pi 本体的 `system_prompt_filter` 机制保证(需要 fork:my-pi 的 `registerSystemPromptFilter` 实现):本扩展注册一个过滤器,只把常驻工具的 snippets/guidelines 放进 system prompt,动态激活/停用工具永远不会改变 system prompt。

## 安装

本地扩展目录方式(直接使用):

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/awoaCrim/pi-cache-stack.git ~/.pi/agent/extensions/cache-stack
```

## 配置

`~/.pi/agent/cache-stack.json`,见 `config.ts` 的 `DEFAULT_CONFIG`。合并前的 `lazy-tools.json` / `compact-safe.json` 不再读取。

## 命令

- `/lazy` — 显示 lazy-tools 状态:激活集、请求体开销、如何激活工具
- `/lazy search <query>` / `/lazy activate <names>` / `/lazy reset`
- 模型侧通过 `lazy` 工具(search / activate / reset)按需激活工具
