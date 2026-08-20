# pi-cache-stack

pi 的缓存优化栈扩展:通过保持请求结构稳定,帮助中继(DeepSeek/new-api 等)的服务器端前缀缓存稳定命中:

1. **lazy-tools** — 按需激活大工具,收缩并稳定请求体 `tools[]`(前缀第 2 段)。常驻集之外的所有已注册工具自动视为懒加载,通过 `lazy` 代理工具按需激活,激活后整个会话保持。
2. **stable tool prompt** — system-prompt 过滤器,让 `system prompt` 与工具激活集解耦(前缀第 1 段恒定)。

本扩展**不实现或存储模型缓存**,也不接管 pi 的压缩流程;实际缓存仍由 Provider 负责。它只通过"请求结构稳定性"间接提高前缀复用概率。

`lazyTools.disabled` 是工具激活限制，不是注册表删除；被禁用工具仍可能被其他诊断接口列出，但不会出现在 active tools、system prompt 或 lazy 激活结果中。默认情况下，system prompt 会用一行稳定的 catalog 列出所有可 lazy 激活的工具名；catalog 不随会话内激活状态变化，因此不会破坏前缀稳定性。

## 前提与降级

- **system prompt 稳定性**依赖 pi 本体的 `system_prompt_filter` 机制(my-pi fork 的 `registerSystemPromptFilter`)。官方 pi 没有该 API 时,扩展会告警并降级:system prompt 可能随工具激活变化,前缀缓存可能 miss。
- **lazy 不是权限隔离**:模型可以搜索并激活所有已注册工具,它只减少工具 schema 和 token。

## 安装

本项目已发布为 npm 包，推荐通过 Pi package manager 安装:

```bash
pi install npm:pi-cache-stack
```

Pi 会读取包内 `package.json` 的 `pi.extensions` 配置并自动加载扩展入口 `index.ts`。如果需要固定版本，可以安装指定版本:

```bash
pi install npm:pi-cache-stack@0.3.0
```

常用管理命令:

```bash
pi update npm:pi-cache-stack
pi remove npm:pi-cache-stack
```

如果之前通过 Pi 安装过 Git 版本，先迁移到 npm 版本:

```bash
pi remove git:github.com/awoaCrim/pi-cache-stack
pi install npm:pi-cache-stack
```

如果之前直接通过 `git clone` 使用本扩展，请删除旧的本地扩展目录 `~/.pi/agent/extensions/cache-stack`，避免同一扩展被重复加载。安装或切换后执行 `/reload`，必要时重启 Pi。

## 配置

`~/.pi/agent/cache-stack.json`,节级深合并,数组整体替换,`null` 视为未设置。

```jsonc
{
  "lazyTools": {
    "enabled": true,
    // 常驻工具集:合并语义(默认集 ∪ 配置集)
    // disabled 中的工具不会激活，也不能通过 lazy 激活
    "alwaysActive": [],
    // 注册但不允许激活的工具
    "disabled": [],
    // 在稳定 system prompt 中列出可 lazy 激活的工具名
    "showCatalogInPrompt": true,
    // 按模型覆盖 lazy policy；支持 * 和 ? 通配符
    // 含 / 的 pattern 匹配 provider/model-id，否则只匹配 model-id
    // 多条规则命中时按声明顺序合并，后面的字段优先
    "modelOverrides": {
      "anthropic/claude-haiku-*": {
        "enabled": false
      },
      "openai/gpt-5.6-*": {
        "enabled": true,
        "alwaysActive": ["mcp"],
        "disabled": [],
        "showCatalogInPrompt": true
      }
    }
  }
}
```

配置文件在 `session_start` 时重载:
- `lazyTools.enabled` 切到 `false` 后,下一次会话恢复 pi 默认全量工具集;
- `lazyTools.alwaysActive`、`disabled`、`showCatalogInPrompt` 和 `modelOverrides` 的文件修改在下一次会话生效(无需重启);
- `showCatalogInPrompt: false` 只隐藏稳定 catalog，不会关闭 lazy 激活；
- 当前会话切换模型时，会立即重新解析并应用已加载配置中的 `modelOverrides`;
- model override 的数组字段替换全局对应数组；默认核心工具仍会与最终 `alwaysActive` 合并;
- `lazyTools.disabled` 中的工具不会进入 active tools，也不能通过 `lazy` 激活；lazy-tools 禁用时恢复 Pi 默认全量工具集。

## 命令

- `/lazy` — 显示 lazy-tools 状态:激活集、请求体开销、如何激活工具
- `/lazy search <query>` / `/lazy activate <names>` / `/lazy reset`
- `lazy search` 会把自然语言查询拆词并按名称/描述命中度排序,例如 `web search URL fetch HTTP` 可同时发现 `web_search` 与 `fetch_content`
- 模型侧通过 `lazy` 工具(search / activate / reset)按需激活工具;system prompt 的稳定 catalog 只列工具名，激活结果会附上该工具的 description + promptGuidelines
- catalog 始终列出完整 lazy pool（包括本会话中已经激活的工具），而不是实时“未激活集合”；这是为了避免每次激活都改变 system prompt
- 网页研究或 HTTP(S) URL 抓取应优先使用专用 Web 工具;只有未激活专用工具时才先通过 `lazy` 搜索,而不是直接退回 bash/curl/Python/Node

## 开发

```bash
npm install --ignore-scripts
npm run typecheck # tsc --noEmit(针对官方 pi 0.84.1 类型)
npm run test      # node --test(strip-types)
```

测试覆盖:配置深合并、lazy 激活与配置 reconcile(启用/禁用切换、alwaysActive 变更、激活 guidance)。

## 发布

`prepublishOnly` 会在发布前自动执行 typecheck 和测试:

```bash
npm publish --access public
```

如果 npm 账号启用了 2FA，发布时需要输入 OTP，或使用允许绕过发布 2FA 的 granular access token。

## 与 my-pi fork 的关系

`my-pi`(https://github.com/awoaCrim/my-pi)是 `earendil-works/pi` 的窄 fork,提供 `registerSystemPromptFilter` 等扩展点;通用能力(`transformContext`、`required: []` 工具 schema 修复)已尽量推回上游。缓存策略本身全部在 `pi-cache-stack`,不侵入 Agent Core。
