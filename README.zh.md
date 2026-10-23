# @local/web-search-auto

[English](README.md) | 中文

一个 `ctx.web` 搜索提供方，把三个后端——Exa、Tavily、TinyFish——放在同一个 provider id 之下。它每次调用挑一个可用后端（粘滞随机、固定优先级或轮询），并在该后端报错或被限流时于同一次调用内降级。适用于 harness 只能指定一个搜索提供方、而部署有多个厂商可分摊与兜底的场景。

它只处理搜索，覆盖三个厂商的 API。它不抓取网页、不按查询切换后端，也不统计用量。

## 安装

包名是 `@local/web-search-auto`。它尚未发布，因此按路径安装。

```bash
git clone https://github.com/imyelo/dsh-web-search-auto.git
cd dsh-web-search-auto
dsh plugin --profile web add "$PWD"
```

bundle 会插入 Loader 行 `web-search-auto`，并注册 provider id `auto`。在同一个 profile 的补丁文件里选中它：

```yaml
- id: web
  config:
    searchProvider: auto      # 等于本插件的 config.id
    fetchProvider: http
```

profile 覆盖会整体替换 `config`，所以要把该行需要的字段全部重述。改动 provider id 或插件代码，下次进程启动时生效。官方 `@deepseek-ai/dsh-web-search-exa` 注册 `exa`；本插件注册 `auto`，因此两者可以同时装在一个 profile 里。

## 配置项

所有字段都有默认值，Loader 行可以整个省略 `config`。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `id` | string | `auto` | 注册到 web 服务的 provider id；`web.searchProvider` 填这个值。 |
| `strategy` | `random` \| `priority` \| `round-robin` | `random` | 单次调用使用的后端顺序。 |
| `order` | string[] | `[exa, tavily, tinyfish]` | `priority` 的优先顺序与并列时的次序；未知 id 被忽略。 |
| `exposeProviders` | boolean | `false` | 额外把每个启用的后端注册为 `<id>-<backend>`。 |
| `cooldownMs` | number | `60000` | 失败后端被跳过的时长。 |
| `rateLimitCooldownMs` | number | `600000` | 返回 402、429 或 432 的后端被跳过的时长。 |
| `timeoutMs` | number | `25000` | 每个后端的单次请求超时。 |
| `snippetMaxChars` | number | `400` | 折叠空白并把摘要截断到该长度；`0` 关闭截断。 |
| `providers.<backend>.enabled` | boolean | `true` | 是否构建并注册该后端。 |
| `providers.<backend>.apiKey` | string | 未设置 | 字面量密钥；优先级最高。 |
| `providers.<backend>.apiKeyEnv` | string | `EXA_API_KEY`、`TAVILY_API_KEY`、`TINYFISH_API_KEY` | 凭据引用，先从凭据服务解析，再回退到启动环境。 |
| `providers.exa.baseURL` | string | `https://api.exa.ai` | 端点基址；追加 `/search`。 |
| `providers.exa.searchType` | `auto` \| `keyword` \| `neural` | `auto` | Exa 检索模式。 |
| `providers.exa.highlightsPerResult` | number | `1` | 每个结果请求的 highlight 句子数。 |
| `providers.exa.numResults` | number | 未设置 | 请求未带 `maxResults` 时发送的结果数。 |
| `providers.tavily.baseURL` | string | `https://api.tavily.com` | 端点基址；追加 `/search`。 |
| `providers.tavily.keyless` | boolean | `true` | 没有密钥时使用 Tavily keyless 访问。 |
| `providers.tavily.searchDepth` | `basic` \| `advanced` | `basic` | Tavily 搜索深度。 |
| `providers.tavily.chunksPerSource` | number | `3` | Tavily 的 `chunks_per_source`。 |
| `providers.tavily.includeAnswer` | boolean | `false` | 向 Tavily 索取答案，并作为 `content` 返回。 |
| `providers.tinyfish.endpoint` | string | `https://agent.tinyfish.ai/mcp` | TinyFish MCP 端点。 |
| `providers.tinyfish.keyless` | boolean | `true` | 没有密钥时使用 TinyFish keyless 访问。 |
| `providers.tinyfish.domainType` | `web` \| `news` \| `research_paper` | `web` | TinyFish 搜索域。 |
| `providers.tinyfish.language` | string | 未设置 | 可选语言代码。 |
| `providers.tinyfish.location` | string | 未设置 | 可选国家代码。 |

## 行为

### 选择

`random` 抽取一个可用后端并在后续调用中复用它；只有该后端报错或进入冷却时才更换。`priority` 取 `order` 中第一个可用后端。`round-robin` 每次调用把 `order` 的起始位置轮换一位。后端的可用性只由是否启用、以及凭据能否本地解析或是否使用 keyless 决定，不做网络检查。要固定某个后端，把 `strategy` 设为 `priority` 并让 `order` 只含该项，或禁用其余后端。

### 降级与冷却

失败的后端进入冷却，同一次调用继续尝试下一个候选并返回第一个成功结果。当所有候选都在冷却时，本次调用忽略冷却，而不是直接返回无结果。调用方的 `AbortSignal` 会立刻抛 `WEB_ABORTED` 并停止降级。两次及以上失败会合并成一个 `WEB_PROVIDER_ERROR`，消息中列出每个后端的失败原因；单个后端失败则原样抛出该错误。

### 凭据

每次搜索依次解析：字面量 `apiKey`、凭据服务、`apiKeyEnv` 指定的启动环境。轮换后的密钥下一次搜索即可生效。keyless 的 Tavily 与 TinyFish 不需要密钥；Exa 没有 keyless 模式。`available()` 只做本地判断：keyless 后端始终可用，带密钥的后端在后台探测完成前保持乐观。

### 结果

每个后端结果映射为一个来源，包含 `url`、可选 `title`、`snippet` 与 `publishedAt`。仅当后端返回散文式内容时才设置 `content`：Tavily 在 `includeAnswer` 下的答案，或 TinyFish 返回的非 JSON 文本。没有 `url` 的结果被丢弃。`maxResults` 会作为结果数发给 Exa 与 Tavily，并由 web 服务对所有后端强制执行；服务截断来源时会设置 `truncated`。

## 限制

- 只做搜索。网页抓取属于 web 服务的 fetch 提供方，例如 `http`。
- 只有一个 provider id。面向模型的 `web_search` 工具无法按查询选择后端；选择是配置行为。
- Exa 需要密钥，其 REST API 没有 keyless 模式。缺少密钥时该后端不可用。
- keyless 的 Tavily 与 TinyFish 使用较低的厂商配额。被限流的后端返回 402、429 或 432，并被跳过 `rateLimitCooldownMs`。
- 冷却保存在进程内存中。重启会忘记冷却，每个 profile 进程各自维护。
- 粘滞 `random` 会把每次搜索都发给同一个后端，直到它失败；它不跨调用做负载均衡。
- 后端可能返回少于请求数量的来源：适配器会丢弃没有 URL 的结果。服务只按 `maxResults` 截断。
- `available()` 可能在凭据探测完成前把带密钥后端报告为可用；该窗口内的搜索可能以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。
- 请求使用裸 `fetch`；插件没有自己的代理或 TLS 选项。重定向会在接触目标前被拒绝。

## 格式与错误

| 后端 | 请求 | 认证 | Keyless |
| --- | --- | --- | --- |
| Exa | `POST {baseURL}/search` | `Authorization: Bearer <key>` | 不可用 |
| Tavily | `POST {baseURL}/search` | `Authorization: Bearer <key>` | `X-Tavily-Access-Mode: keyless` |
| TinyFish | `POST {endpoint}`，MCP `tools/call` `search`；带密钥时先 `initialize` | `X-API-Key` | `X-TinyFish-Access-Mode: keyless` |

| 结果字段 | Exa | Tavily | TinyFish |
| --- | --- | --- | --- |
| `url` | `results[].url` | `results[].url` | 文本 JSON 载荷中的 `results[].url` |
| `title` | `title` | `title` | `title` |
| `snippet` | 首个非空 highlight | `content` | `snippet` 或 `content` |
| `publishedAt` | `publishedDate` | `published_date` 或 `publishedDate` | `date` |
| `content` | — | `includeAnswer` 下的 `answer` | 非 JSON 文本载荷 |

| 错误码 | 触发条件 |
| --- | --- |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | 后端需要密钥却没有解析到：Exa 总是如此，Tavily 或 TinyFish 在 `keyless: false` 时如此。 |
| `WEB_PROVIDER_UNAVAILABLE` | 调用时没有任何可用后端。 |
| `WEB_ABORTED` | 调用方的 `AbortSignal` 触发。 |
| `WEB_PROVIDER_ERROR` | 请求失败、返回非 2xx、响应体无法解析、返回 JSON-RPC 错误，或所有后端都失败（聚合错误；`cause` 是最后一个错误）。 |

`web.searchProvider` 指向未注册的 id 属于 web 服务的错误，不是本提供方的错误。

## 开发

```bash
npm test
node --test test/selector.test.mjs
```

测试覆盖选择与降级、三个厂商适配器（本地 mock server）、配置默认值与凭据优先级，以及一次装入临时 `DSH_HOME` 的安装冒烟。harness 自身的 Loader 与 web 服务行为不重复测试。仓库没有依赖，也没有 lockfile。测试需要 Node 22.15 或更新版本，且 `dsh` 在 `PATH` 中；可用 `DSH_BIN` 或 `DSH_INSTALL_NODE_MODULES` 覆盖安装发现。

## 许可

本仓库未声明许可证。
