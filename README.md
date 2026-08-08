# pi-cache-stack

pi 的缓存优化栈扩展:通过保持请求结构稳定,帮助中继(DeepSeek/new-api 等)的服务器端前缀缓存稳定命中:

1. **lazy-tools** — 按需激活大工具,收缩并稳定请求体 `tools[]`(前缀第 2 段)。常驻集之外的所有已注册工具自动视为懒加载,通过 `lazy` 代理工具按需激活,激活后整个会话保持。
2. **stable tool prompt** — system-prompt 过滤器,让 `system prompt` 与工具激活集解耦(前缀第 1 段恒定)。

本扩展**不实现或存储模型缓存**,也不接管 pi 的压缩流程;实际缓存仍由 Provider 负责。它只通过"请求结构稳定性"间接提高前缀复用概率。

## 前提与降级

- **system prompt 稳定性**依赖 pi 本体的 `system_prompt_filter` 机制(my-pi fork 的 `registerSystemPromptFilter`)。官方 pi 没有该 API 时,扩展会告警并降级:system prompt 可能随工具激活变化,前缀缓存可能 miss。
- **lazy 不是权限隔离**:模型可以搜索并激活所有已注册工具,它只减少工具 schema 和 token。

## 安装

本地扩展目录方式(直接使用):

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/awoaCrim/pi-cache-stack.git ~/.pi/agent/extensions/cache-stack
```

## 配置

`~/.pi/agent/cache-stack.json`,节级深合并,数组整体替换,`null` 视为未设置。

```jsonc
{
  "lazyTools": {
    "enabled": true,
    // 常驻工具集:合并语义(默认集 ∪ 配置集),只能追加不能删核心工具
    "alwaysActive": []
  }
}
```

配置变更在 `session_start` 时重载:
- `lazyTools.enabled` 切到 `false` 后,下一次会话恢复 pi 默认全量工具集;
- `lazyTools.alwaysActive` 变更在下一次会话生效(无需重启)。

## 命令

- `/lazy` — 显示 lazy-tools 状态:激活集、请求体开销、如何激活工具
- `/lazy search <query>` / `/lazy activate <names>` / `/lazy reset`
- 模型侧通过 `lazy` 工具(search / activate / reset)按需激活工具;激活结果会附上该工具的 description + promptGuidelines(system prompt 为保持前缀稳定只含常驻工具,动态工具的用法说明随激活结果给出)

## 开发

```bash
npm install --ignore-scripts
npm test          # node --test(strip-types)
npm run typecheck # tsc --noEmit(针对官方 pi 0.84.1 类型)
```

测试覆盖:配置深合并、lazy 激活与配置 reconcile(启用/禁用切换、alwaysActive 变更、激活 guidance)。

## 与 my-pi fork 的关系

`my-pi`(https://github.com/awoaCrim/my-pi)是 `earendil-works/pi` 的窄 fork,提供 `registerSystemPromptFilter` 等扩展点;通用能力(`transformContext`、`required: []` 工具 schema 修复)已尽量推回上游。缓存策略本身全部在 `pi-cache-stack`,不侵入 Agent Core。
