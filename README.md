# web-search-auto

一个 `ctx.web` 搜索 provider：**一个复合 provider，内部持有多后端**（Exa / Tavily / TinyFish），
实现 dsh seam 故意不提供的两件事——**选择**与**降级**：

| 策略 | 行为 |
|---|---|
| `random`（默认） | 像 OpenCode 的 `provider: "random"`：随机挑一个可用后端并**一直用它**，直到它失败/被限流，才在本次调用内换另一个。 |
| `priority` | 按 `order` 从上到下依次尝试，前一个失败才用后一个（固定优先级降级链）。 |
| `round-robin` | 每次调用轮换起始后端，其余顺序照 `order`。 |

失败的后端进入冷却（普通失败 `cooldownMs`，HTTP 402/429/432 用 `rateLimitCooldownMs`），
冷却期间不被选中；若**所有**后端都在冷却，则忽略冷却照常尝试（不制造人为全挂）。
调用方取消（`AbortSignal`）时立即抛 `WEB_ABORTED`，**不会**触发降级。

> 为什么必须是「一个复合 provider」：dsh 的 seam 在**每次调用时**按配置的单个 id 选 provider，
> 没有级联。要支持随机+降级，只能注册一个统一 id（默认 `auto`），由它内部调度。
> 语义见 `@deepseek-ai/dsh-web` README 的 "Provider selection"。

## 后端与凭据

| 后端 | 端点 | 认证 | 无 key 时 |
|---|---|---|---|
| Exa | `POST https://api.exa.ai/search`（REST） | `Authorization: Bearer` | **不可用**（Exa 无 keyless REST 模式） |
| Tavily | `POST https://api.tavily.com/search` | `Authorization: Bearer` | keyless：`X-Tavily-Access-Mode: keyless`（默认开启） |
| TinyFish | MCP over HTTP `https://agent.tinyfish.ai/mcp` | `X-API-Key` + `initialize` 拿 `Mcp-Session-Id` | keyless：`X-TinyFish-Access-Mode: keyless`（默认开启） |

key 解析顺序（每次搜索时重新解析，换 key 不用重启）：

1. 配置里的字面量 `providers.<backend>.apiKey`（`role('secret')`，UI 会掩码）
2. `ctx.credentials`（Web Models 页/`credentials` 服务写入的管理型凭据）
3. 启动环境快照（`~/.dsh/.env`、项目 `.env`、进程环境）里的 `apiKeyEnv`

`available()` 必须是纯本地判断：它用「字面量/启动环境是否已有」+ 后台异步探测的缓存回答，
**不发任何网络请求**。

## 安装与激活

插件代码留在本仓库，profile 只记一条 link。安装（两种等价方式，任选其一）：

```bash
# 方式 A：CLI
dsh plugin --profile web add /Users/yelo/Repositories/yelo/dsh-web-search-auto

# 方式 B：本会话里的 plugin_manager
#   action: install_bundle
#   target: /Users/yelo/Repositories/yelo/dsh-web-search-auto
```

安装后 `~/.dsh/profiles/web/cordis.patch.yml` **不需要**再加插件行（bundle 自带的
`cordis.patch.yml` 会 `insert` 行 `web-search-auto`）。但**选中它**是用户层的事——把已有的
`web` 行覆盖改成：

```yaml
- id: web
  config:
    searchProvider: auto      # ← 本插件的 provider id（config.id 可改）
    fetchProvider: http
```

原来的 Exa 行（`web-search-exa`）可以留着不管：它注册的 id 是 `exa`，与 `auto` 不冲突；
只有 `searchProvider` 指向谁，谁才会被调用。想减少噪音可加：

```yaml
- id: web-search-exa
  disabled: true
```

改 `cordis.patch.yml` 会被 profile 监听（`patchReload: live`），但**新插件模块**仍建议重启进程。
验证顺序：

```bash
dsh plugin --profile web list                 # 看 @local/web-search-auto 是否装上
dsh --profile web --dump-config | grep -A8 '^- id: web$'   # 看 searchProvider: auto
```

实际搜索：在 GUI/终端会话里让 agent 调一次 `web_search`；或临时把 `exposeProviders` 打开，
直接把 `searchProvider` 指到 `auto-tavily` / `auto-tinyfish` 单独验证某个后端。

## 配置参考

所有字段都有默认值，行 `config` 可以整个省略。**注意：用户层覆盖会整体替换 `config`**，
只写要改的字段时，其余字段由本插件的 schema 默认值补齐（默认值在插件里，不在 patch 里）。

```yaml
- insert:
    - id: web-search-auto
      name: '@local/web-search-auto'
      config:
        id: auto                  # 注册的 provider id；web.searchProvider 要写这个
        strategy: random          # random | priority | round-robin
        order: [exa, tavily, tinyfish]
        exposeProviders: false    # true 时额外注册 auto-exa / auto-tavily / auto-tinyfish
        cooldownMs: 60000         # 普通失败冷却
        rateLimitCooldownMs: 600000  # 402/429/432 冷却
        timeoutMs: 25000          # 单次后端请求超时
        snippetMaxChars: 400      # 摘要折叠空白并截断（0 关闭）
        providers:
          exa:
            enabled: true
            apiKey: !!js process.env.EXA_API_KEY   # 缺省时回退 apiKeyEnv → credentials
            apiKeyEnv: EXA_API_KEY
            baseURL: https://api.exa.ai
            searchType: auto      # auto | keyword | neural
            highlightsPerResult: 1
            numResults: 8
          tavily:
            enabled: true
            apiKey: !!js process.env.TAVILY_API_KEY
            apiKeyEnv: TAVILY_API_KEY
            baseURL: https://api.tavily.com
            keyless: true         # 无 key 用 keyless 模式而不是停用
            searchDepth: basic    # basic | advanced
            chunksPerSource: 3
            includeAnswer: false  # true 时把 Tavily 的 answer 作为 content 返回
          tinyfish:
            enabled: true
            apiKey: !!js process.env.TINYFISH_API_KEY
            apiKeyEnv: TINYFISH_API_KEY
            endpoint: https://agent.tinyfish.ai/mcp
            keyless: true
            domainType: web       # web | news | research_paper
            language: ''          # 可选
            location: ''          # 可选
```

`apiKey: !!js process.env.XXX` 在变量缺失时得到 `undefined`，插件会自动回退到
`apiKeyEnv` → credentials → 启动环境，三种来源互不冲突。

## 返回结果映射

| seam 字段 | Exa | Tavily | TinyFish |
|---|---|---|---|
| `url` | `results[].url` | `results[].url` | 文本块 JSON 的 `results[].url` |
| `title` | `title` | `title` | `title` |
| `snippet` | 第一条非空 `highlights[]` | `content`（markdown 会被折叠空白并截断） | `snippet` |
| `publishedAt` | `publishedDate`（ISO） | `published_date`（ISO） | `date`（仅当 ISO） |
| `content` | — | `answer`（`includeAnswer: true` 时） | 非 JSON 文本时整体作为 `content` |

`maxResults` 会作为结果数提示传给 Exa/Tavily；TinyFish 没有结果数参数，最终截断由 seam 完成
（`truncated` 由 seam 置位，插件不伪造）。

## 排障

| 现象 | 原因/处理 |
|---|---|
| `WEB_PROVIDER_CONFIGURED_MISSING` | `web.searchProvider` 不等于本插件 `config.id`（默认 `auto`） |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | 所有后端都不可用（例如 Exa 无 key 且 Tavily/TinyFish 都 `keyless: false`） |
| `every search backend failed (...)` | 聚合错误，分号分隔列出每个后端的原因；看 `probe` 字段 |
| 日志里 `search backend X failed, failing over` | 正常降级（debug 级） |
| 想固定某个后端 | 临时设 `providers.exa.enabled: false` 等，或 `strategy: priority` + `order: [tavily]` |

## 测试

`test/` 是一套零依赖的 `node:test` 测试，**只测本插件拥有的逻辑**；DSH 自身的 Loader、
service registry、seam 选择语义被当作可靠，不在插件仓库里重复测试。

| 文件 | 覆盖 |
|---|---|
| `test/selector.test.mjs` | 选择策略、降级、冷却/限流冷却、取消、错误聚合 |
| `test/adapters.test.mjs` | Exa / Tavily / TinyFish 的请求形状与响应映射（本地 mock server，不联网） |
| `test/plugin.test.mjs` | `Config` 默认值与边界、`apply()` 接线、凭据解析顺序 |
| `test/composition.smoke.test.mjs` | 安装冒烟：临时 `DSH_HOME` 装入 bundle、patch 行挂载、`skippedBundles` 为空、兼容闸门通过 |

```bash
npm test                              # node --test test/*.test.mjs
node --test test/selector.test.mjs    # 只跑一个文件
```

测试通过 `scripts/test-hooks.mjs` 把裸 `@deepseek-ai/*` 解析到**已安装的 dsh**：它从 PATH 上的
`dsh` 反推安装目录（也可用 `DSH_BIN` / `DSH_INSTALL_NODE_MODULES` 指定），所以本仓库不需要
`node_modules`、不声明依赖，测试跑在你当前实际使用的运行时上。安装冒烟只跨一次界：它证明 bundle
能装、patch 的最终效果正确——DSH 的合并语义本身不在这里断言。

## 与官方 Exa 插件的关系

本插件的 Exa 后端与 `@deepseek-ai/dsh-web-search-exa` 同源（同一个 REST 契约），但**不依赖**它；
两者可以共存。若都注册，provider id 分别是 `exa`（官方）与 `auto`（本插件），不会冲突。
