# dsh-web-search-auto

> 🔎 一个在多个搜索后端之间分流、并自动故障转移的 DeepSeek Harness 网页搜索插件。

[English](README.md) | 中文

目前支持 Exa、Tavily、TinyFish —— 就像 [Opencode v2 自带的 WebSearch](https://opencode.ai/v2/docs/websearch/) 特性。你可以通过设置全局共享的环境变量，或在 cordis patch 中配置后端，插件会自动分发搜索任务。

## 特性

- 🧩 **多合一**：一次安装就带上全部后端，不必为每家厂商单独安装插件。
- ⚙️ **简单配置**：只设环境变量或写几行 `config`，其余字段都有默认值。
- 🔁 **故障转移**：某个后端失败就冷却一段时间，同一次调用改试下一个。
- 🎲 **分流**：`random`、`priority`、`round-robin` 三种策略决定后端顺序。
- 🔍 **多渠道比对**（TODO）：同一次查询向多个后端取结果再比对。

## 支持的厂商

- Exa（REST）
- Tavily（REST）
- TinyFish（MCP over HTTP）

## 安装

```bash
dsh plugin --profile web add dsh-web-search-auto
```

bundle 会添加插件条目 `web-search-auto`，并注册搜索提供方 `auto`。在同一个 profile 的补丁文件里设置这个提供方：

```yaml
- id: web
  config:
    searchProvider: auto      # 等于本插件的 config.id
    fetchProvider: http
```

## 配置后端

每个后端有两种配置形式，可以混用：

| 形式 | 用途 |
| --- | --- |
| 环境变量 | 放密钥，全局共享。插件按名字自动读取。 |
| cordis patch | 在插件条目的 `config` 里写密钥、端点与检索参数。 |

| 后端 | 环境变量 | cordis patch 密钥字段 | 无密钥可用 |
| --- | --- | --- | --- |
| Exa | `EXA_API_KEY` | `providers.exa.apiKey` | 否 |
| Tavily | `TAVILY_API_KEY` | `providers.tavily.apiKey` | 是 |
| TinyFish | `TINYFISH_API_KEY` | `providers.tinyfish.apiKey` | 是 |

环境变量可以来自进程环境，也可以来自 dsh 启动时读取的 `.env`：启动目录的 `.env` 与 `$DSH_HOME/.env`。按此顺序，前面的来源优先。

```bash
export EXA_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
```

等价的 cordis patch 写法。只列出要改的字段，其余保留默认值：

```yaml
- id: web-search-auto
  config:
    providers:
      exa:
        apiKey: sk-...               # 直接写密钥
      tavily:
        apiKeyEnv: MY_TAVILY_KEY     # 换成别的变量名或凭据名
        searchDepth: advanced
      tinyfish:
        enabled: false               # 不启用这个后端
```

所有字段见下节。选后端的方式与 [Opencode v2 的 WebSearch](https://opencode.ai/v2/docs/websearch/) 类似：`random` 选中一个后端后就沿用它。这里还多两种策略，而且故障时能够自动切换后端 —— Opencode v2 只在 HTTP 429 时切换。

## 配置项

所有字段都有默认值。插件条目可以整个省略 `config`。

### 提供方

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `id` | string | `auto` | 插件注册到 web 服务的 provider id。`web.searchProvider` 填这个值。 |
| `strategy` | `random` \| `priority` \| `round-robin` | `random` | 插件在单次调用中使用的后端顺序。 |
| `order` | string[] | `[exa, tavily, tinyfish]` | `priority` 的优先顺序与并列时的次序。插件忽略未知 id。 |
| `exposeProviders` | boolean | `false` | 为 true 时，插件额外把每个启用的后端注册为 `<id>-<backend>`。 |

### 超时与冷却

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `cooldownMs` | number | `60000` | 插件跳过失败后端的时长。 |
| `rateLimitCooldownMs` | number | `600000` | 插件跳过返回 402、429 或 432 的后端的时长。 |
| `timeoutMs` | number | `25000` | 每个后端的单次请求超时。 |

### 结果

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `snippetMaxChars` | number | `400` | 折叠空白并把摘要截断到该长度。`0` 关闭截断。 |

### 每个后端通用（`providers.<backend>`）

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 插件是否构建并注册该后端。 |
| `apiKey` | string | 未设置 | 直接写密钥。优先级最高。 |
| `apiKeyEnv` | string | `EXA_API_KEY`、`TAVILY_API_KEY`、`TINYFISH_API_KEY` | 密钥名。插件先读凭据存储，再读环境变量。 |

### Exa（`providers.exa`）

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `baseURL` | string | `https://api.exa.ai` | 端点基址。插件追加 `/search`。 |
| `searchType` | `auto` \| `keyword` \| `neural` | `auto` | Exa 检索模式。 |
| `highlightsPerResult` | number | `1` | 每个结果请求的 highlight 句子数。 |
| `numResults` | number | 未设置 | 请求没有 `maxResults` 时，插件发送的结果数。 |

### Tavily（`providers.tavily`）

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `baseURL` | string | `https://api.tavily.com` | 端点基址。插件追加 `/search`。 |
| `keyless` | boolean | `true` | 没有密钥时，以无密钥方式使用 Tavily。 |
| `searchDepth` | `basic` \| `advanced` | `basic` | Tavily 搜索深度。 |
| `chunksPerSource` | number | `3` | Tavily 的 `chunks_per_source`。 |
| `includeAnswer` | boolean | `false` | 向 Tavily 索取答案。插件把它作为 `content` 返回。 |

### TinyFish（`providers.tinyfish`）

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `endpoint` | string | `https://agent.tinyfish.ai/mcp` | TinyFish MCP 端点。 |
| `keyless` | boolean | `true` | 没有密钥时，以无密钥方式使用 TinyFish。 |
| `domainType` | `web` \| `news` \| `research_paper` | `web` | TinyFish 搜索域。 |
| `language` | string | 未设置 | 可选语言代码。 |
| `location` | string | 未设置 | 可选国家代码。 |

## 行为

### 选择后端

`random` 选一个可用后端。插件在后续调用中继续使用这个后端。只有它失败或进入冷却时，插件才更换。`priority` 使用 `order` 中第一个可用后端。`round-robin` 每次调用把 `order` 的起始位置向前移动一位。

后端可用的条件是 `enabled` 为 true。后端还必须满足一项：本地能拿到密钥，或者它支持无密钥运行。插件不检查网络。

要只用一个后端，把 `strategy` 设为 `priority`，并让 `order` 只含该项。也可以禁用其余后端。

### 失败切换与冷却

插件会在一段时间内跳过失败的后端。同一次调用继续尝试下一个候选，并返回第一个成功结果。如果插件跳过所有候选，本次调用忽略跳过状态，逐个尝试候选项。如果调用方通过 `AbortSignal` 取消，调用以 `WEB_ABORTED` 停止。它不再尝试其他后端。

两次及以上失败会合并成一个 `WEB_PROVIDER_ERROR`，消息中列出每个后端。单个后端失败时，返回它自己的错误。

### 密钥

每个后端按以下顺序取密钥：

1. `config.providers.<backend>.apiKey`：直接写在插件条目 `config` 里的明文密钥，优先级最高。
2. `config.providers.<backend>.apiKeyEnv` 指定的名字，从 harness 凭据存储解析。
3. 同名的环境变量，例如 `EXA_API_KEY`。它可以来自进程环境，也可以来自启动目录或 `$DSH_HOME` 下的 `.env`。

`apiKey` 是插件 `config` 的字段，不是 dsh 的启动参数。轮换后的密钥下一次搜索即可生效。

Tavily 与 TinyFish 可以无密钥运行。Exa 不行。`available()` 只检查本地状态。不需要密钥的后端始终可用。需要密钥的后端在后台密钥检查完成前，插件按可用处理。

### 结果

每个结果映射为一个来源，包含 `url`、可选 `title`、`snippet` 与 `publishedAt`。仅当后端返回文本时，插件才设置 `content`。例子包括开启 `includeAnswer` 时 Tavily 的答案，以及 TinyFish 返回的非 JSON 响应。

插件丢弃没有 URL 的结果。它把 `maxResults` 作为结果数发给 Exa 与 Tavily。web 服务对所有后端执行这个上限。服务截断来源时设置 `truncated`。

## 限制

- 仅使用厂商提供的面向 Agent 的标准搜索 API。插件不包含非官方接口的逆向抓取（例如 Reddit、X 等站内搜索）。
- 只做搜索。网页抓取由 web 服务的 fetch 提供方负责，例如 `http`。
- 只有一个 provider id。`web_search` 工具无法按查询选择后端。选择是配置行为。
- 每次搜索只由一个后端返回结果。插件不比对或合并多个后端的结果。
- Exa 需要密钥，没有无密钥模式。缺少密钥时，该后端不可用。
- 无密钥的 Tavily 与 TinyFish 使用厂商较低的无密钥配额。被限流的后端返回 402、429 或 432。插件跳过它 `rateLimitCooldownMs`。
- 插件把冷却保存在进程内存中。重启会清除冷却。每个进程各自维护。
- 默认的 `random` 模式把每次搜索都发给同一个后端，直到它失败。它不跨调用分摊负载。
- 后端可能返回少于请求数量的来源，因为插件丢弃没有 URL 的结果。web 服务只按 `maxResults` 截断。
- `available()` 可能在密钥检查完成前把需要密钥的后端报告为可用。该窗口内的搜索可能以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。
- 请求使用内置的 `fetch`。插件没有自己的代理或 TLS 设置。插件在接触目标前拒绝重定向。

## 格式与错误

| 后端 | 请求 | 认证 | 无密钥模式 |
| --- | --- | --- | --- |
| Exa | `POST {baseURL}/search` | `Authorization: Bearer <key>` | 不可用 |
| Tavily | `POST {baseURL}/search` | `Authorization: Bearer <key>` | `X-Tavily-Access-Mode: keyless` |
| TinyFish | `POST {endpoint}`，MCP `tools/call` `search`。需要密钥时先 `initialize`。 | `X-API-Key` | `X-TinyFish-Access-Mode: keyless` |

| 结果字段 | Exa | Tavily | TinyFish |
| --- | --- | --- | --- |
| `url` | `results[].url` | `results[].url` | JSON 文本响应中的 `results[].url` |
| `title` | `title` | `title` | `title` |
| `snippet` | 首个非空 highlight | `content` | `snippet` 或 `content` |
| `publishedAt` | `publishedDate` | `published_date` 或 `publishedDate` | `date` |
| `content` | — | `includeAnswer` 下的 `answer` | 非 JSON 文本响应 |

| 错误码 | 触发条件 |
| --- | --- |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | 后端需要密钥，但没有可用密钥。Exa 总是需要密钥。Tavily 或 TinyFish 在 `keyless` 为 false 时需要密钥。 |
| `WEB_PROVIDER_UNAVAILABLE` | 调用时没有可用后端。 |
| `WEB_ABORTED` | 调用方的 `AbortSignal` 触发。 |
| `WEB_PROVIDER_ERROR` | 请求失败、返回非 2xx、响应体无法解析、返回 JSON-RPC 错误，或所有后端都失败。合并后的错误列出每项失败，并把 `cause` 设为最后一个失败。 |

## 开发

```bash
npm test
node --test test/selector.test.mjs
```

测试覆盖选择与失败切换、三个厂商适配器（本地 mock server）、配置默认值与密钥优先级，以及一次装入临时 `DSH_HOME` 的安装检查。

每个厂商适配器位于 `lib/providers/`。要支持其他搜索 API，添加一个适配器，并在 `index.js` 与 `lib/config.js` 中接入。

仓库没有依赖，也没有 lockfile。测试需要 Node 22.15 或更新版本，且 `dsh` 在 `PATH` 中。`DSH_BIN` 或 `DSH_INSTALL_NODE_MODULES` 可以覆盖安装发现。

## 许可

[Apache-2.0](./LICENSE) © [yelo](https://github.com/imyelo), 2026 - present
