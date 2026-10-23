# dsh-web-search-auto

> 🔎 A DeepSeek Harness web search plugin that routes across several search backends, with automatic failover.

English | [中文](README.zh.md)

It takes Exa, Tavily and TinyFish today — much like [the WebSearch built into Opencode v2](https://opencode.ai/v2/docs/websearch/). Set globally shared environment variables, or configure the backends in a cordis patch; the plugin then routes searches for you.

## Features

- 🧩 **All in one**: one install covers every backend, so there is no per-vendor plugin to add.
- ⚙️ **Simple setup**: set an environment variable or a few `config` lines, and every other field keeps its default.
- 🔁 **Failover**: a failing backend cools down and the same call tries the next one.
- 🎲 **Routing**: `random`, `priority` or `round-robin` decides the backend order.
- ~~🔍 **Cross-check** (TODO): query several backends at once and compare their results.~~

## Supported vendors

- Exa (REST)
- Tavily (REST)
- TinyFish (MCP over HTTP)

## Install

```bash
dsh plugin --profile web add dsh-web-search-auto
```

The bundle adds the plugin entry `web-search-auto` and registers the search provider `auto`. Set this provider in the same profile's patch file:

```yaml
- id: web
  config:
    searchProvider: auto      # equals this plugin's config.id
    fetchProvider: http
```

## Configure the backends

Each backend takes two configuration forms, and you can mix them:

| Form | Use |
| --- | --- |
| Environment variable | Holds the key, shared globally. The plugin reads it by name. |
| cordis patch | Sets keys, endpoints and retrieval options on the plugin entry's `config`. |

| Backend | Environment variable | Key field in a cordis patch | Runs keyless |
| --- | --- | --- | --- |
| Exa | `EXA_API_KEY` | `providers.exa.apiKey` | No |
| Tavily | `TAVILY_API_KEY` | `providers.tavily.apiKey` | Yes |
| TinyFish | `TINYFISH_API_KEY` | `providers.tinyfish.apiKey` | Yes |

The variable can come from the process environment, or from a `.env` file that dsh reads at startup: `<launch directory>/.env` and `$DSH_HOME/.env`. In that order, the earlier source wins.

```bash
export EXA_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
```

The equivalent cordis patch. List only the fields you change. The rest keep their defaults:

```yaml
- id: web-search-auto
  config:
    providers:
      exa:
        apiKey: sk-...               # literal key
      tavily:
        apiKeyEnv: MY_TAVILY_KEY     # another variable or credential name
        searchDepth: advanced
      tinyfish:
        enabled: false               # do not use this backend
```

Every field is in the next section. Picking a backend works like [Opencode v2 WebSearch](https://opencode.ai/v2/docs/websearch/): `random` keeps the backend it picked. This plugin adds two more strategies, and it fails over automatically on failure — Opencode v2 switches only on HTTP 429.

## Options

Every field is optional.

### Providers

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `id` | string | `auto` | Provider id that the plugin registers with the web service. `web.searchProvider` names it. |
| `strategy` | `random` \| `priority` \| `round-robin` | `random` | Backend order that the plugin uses for one call. |
| `order` | string[] | `[exa, tavily, tinyfish]` | Preference order for `priority` and the rotation sequence for `round-robin`. `random` ignores it. |
| `exposeProviders` | boolean | `false` | If true, also registers each enabled backend as `<id>-<backend>` for manual selection. |

### Timeouts and cooldown

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `cooldownMs` | number | `60000` | How long the plugin skips a failed backend. |
| `rateLimitCooldownMs` | number | `600000` | How long the plugin skips a backend that answered 402, 429 or 432. |
| `timeoutMs` | number | `25000` | Per-request timeout for each backend. |

### Results

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `snippetMaxChars` | number | `400` | Collapse whitespace and cap snippets at this length. `0` disables the cap. |

### Shared by every backend (`providers.<backend>`)

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Whether the plugin builds and registers the backend. |
| `apiKey` | string | unset | Literal key. It has the highest precedence. |
| `apiKeyEnv` | string | `EXA_API_KEY`, `TAVILY_API_KEY`, `TINYFISH_API_KEY` | Key name. The plugin reads the credential store first, then the environment. |

### Exa (`providers.exa`)

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `baseURL` | string | `https://api.exa.ai` | Endpoint base. The plugin appends `/search`. |
| `searchType` | `auto` \| `keyword` \| `neural` | `auto` | Exa retrieval mode. |
| `highlightsPerResult` | number | `1` | Highlight snippets requested per result. Only the first non-blank one becomes the snippet. |
| `numResults` | number | unset | Result count that the plugin sends when the request has no `maxResults`. |

The built-in `web_search` tool always sends `maxResults` (default 8), so `numResults` only applies to direct `ctx.web.search` callers that omit it.

### Tavily (`providers.tavily`)

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `baseURL` | string | `https://api.tavily.com` | Endpoint base. The plugin appends `/search`. |
| `keyless` | boolean | `true` | Use Tavily without a key when no key is available. |
| `searchDepth` | `basic` \| `advanced` | `basic` | Tavily search depth. |
| `chunksPerSource` | number | `3` | Tavily `chunks_per_source`. |
| `includeAnswer` | boolean | `false` | Ask Tavily for an answer. The plugin exposes it as `content`. |

### TinyFish (`providers.tinyfish`)

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `endpoint` | string | `https://agent.tinyfish.ai/mcp` | TinyFish MCP endpoint. |
| `keyless` | boolean | `true` | Use TinyFish without a key when no key is available. |
| `domainType` | `web` \| `news` \| `research_paper` | `web` | TinyFish search domain. |
| `language` | string | unset | Optional language code. |
| `location` | string | unset | Optional country code. |

## Behavior

### Choosing a backend

Three strategies decide which backend a call tries first:

- `random` (default): picks one usable backend at random and keeps using it. It switches only when that backend fails or is cooling down. This strategy ignores `order`.
- `priority`: walks `order` top-down and uses the first usable backend.
- `round-robin`: sorts by `order`, then moves the starting position forward by one for each call and tries from there.

A backend is usable when all of the following hold:

1. `enabled` is true (default).
2. Its `baseURL` or `endpoint` is a valid URL.
3. One of the key conditions holds: its key is available locally, or the backend runs without a key.

The plugin only checks local state. It does not probe network reachability.

To disable a specific provider that otherwise meets the usable conditions, set its `enabled` to `false` manually.

### Failover and cooldown

The plugin skips a failed backend for a while. The same call tries the next candidate and returns the first success. If the plugin skips every candidate, the call ignores the skips and tries each candidate. If the caller cancels through `AbortSignal`, the call stops with `WEB_ABORTED`. It does not try another backend.

Two or more failures produce one `WEB_PROVIDER_ERROR` that lists each backend. A single failing backend returns its own error.

### Credentials

Each backend resolves its key in this order:

1. `config.providers.<backend>.apiKey`: a plaintext key written on the plugin entry's `config`. It has the highest precedence.
2. The name in `config.providers.<backend>.apiKeyEnv`, resolved through the harness credential store.
3. The environment variable of that name, such as `EXA_API_KEY`. It comes from the process environment, or from a `.env` in the launch directory or in `$DSH_HOME`.

`apiKey` is a field of the plugin `config`, not a dsh launch argument. A key changed in the credential store applies to the next search. The launch environment and `.env` files are read once at startup, so changing them requires a restart. A keyed backend that was marked unavailable re-checks itself when the credential store reports a change for its reference.

Tavily and TinyFish support running without a key.

`available()` checks only local state. Backends that need no key are always usable.

The plugin treats a backend that needs a key as usable until its background key check finishes; after the check finds no key, the backend stays unavailable until the credential store changes or the plugin reloads.

### Results

Each result becomes a source with `url` plus optional `title`, `snippet` and `publishedAt`. `publishedAt` is normalized to ISO-8601: Exa returns ISO dates, Tavily's RFC 2822 `published_date` is converted, and TinyFish's human dates such as `Sep 8, 2026` or relative ages such as `2 months ago` are converted or approximated from the search time. A result without a parseable date omits the field.

The plugin sets `content` only when a backend returns text. Examples are Tavily's answer when `includeAnswer` is on, and a TinyFish `tools/call` text block that is not JSON.

The plugin drops results without a URL. It sends `maxResults` to Exa and Tavily as a result count. The web service enforces the bound for every backend. The service sets `truncated` when it cuts sources.

## Limits

- The plugin calls only vendor-provided search APIs built for agents. It has no unofficial reverse-engineered scraping for site search, such as Reddit or X.
- Search only. The web service's fetch provider, such as `http`, handles page fetching.
- One composite provider id by default. `exposeProviders` adds per-backend ids for manual selection, but the `web_search` tool still cannot choose one per query; selection is configuration.
- One backend answers each search. The plugin does not compare or merge results from several backends.
- Exa requires a key. It has no keyless mode. Without a key, that backend is unavailable.
- Tavily and TinyFish without a key use the vendors' lower no-key quotas. A rate-limited backend returns 402, 429 or 432. The plugin skips it for `rateLimitCooldownMs`.
- The plugin keeps cooldowns in memory. A restart clears them. Each process keeps its own.
- The default `random` mode sends every search to one backend until that backend fails. It does not spread load across calls.
- A backend can return fewer sources than requested because the plugin drops results without a URL. The web service truncates only to `maxResults`.
- `available()` can report a backend with a key as usable before its key check finishes. A search in that window can fail with `WEB_PROVIDER_CREDENTIAL_MISSING`.
- Requests use the built-in `fetch`. The plugin has no proxy or TLS settings of its own. The plugin does not follow redirects; a redirect response is a provider error.

## Format and errors

| Backend | Request | Auth | Keyless |
| --- | --- | --- | --- |
| Exa | `POST {baseURL}/search` | `Authorization: Bearer <key>` | Not available |
| Tavily | `POST {baseURL}/search` | `Authorization: Bearer <key>` | `X-Tavily-Access-Mode: keyless` |
| TinyFish | `POST {endpoint}` with MCP `tools/call` `search`. Keyed requests `initialize` first. | `X-API-Key` | `X-TinyFish-Access-Mode: keyless` |

| Result field | Exa | Tavily | TinyFish |
| --- | --- | --- | --- |
| `url` | `results[].url` | `results[].url` | `results[].url` in the JSON text response |
| `title` | `title` | `title` | `title` |
| `snippet` | First non-blank highlight | `content` | `snippet` or `content` |
| `publishedAt` | `publishedDate` (ISO) | `published_date` (RFC 2822, normalized) | `date` (human or relative, normalized) |
| `content` | — | `answer` with `includeAnswer` | Non-JSON `tools/call` text block |

The first three codes below are raised by the web seam before the plugin runs; `WEB_PROVIDER_UNAVAILABLE` can come from either layer, and the rest are the plugin's own contract. In the documented `searchProvider: auto` setup, a completely unusable backend pool surfaces as `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, not `WEB_PROVIDER_UNAVAILABLE`.

| Code | Raised when |
| --- | --- |
| `WEB_PROVIDER_CONFIGURED_MISSING` | `web.searchProvider` names an id that is not registered, for example a typo or a profile where every backend is disabled. |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | The pinned `auto` provider is registered but every backend is unusable. |
| `WEB_PROVIDER_AMBIGUOUS` | No provider id is pinned and more than one usable provider is registered. |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | A backend needs a key and none is available. Exa always needs a key. Tavily or TinyFish need one when `keyless` is false. |
| `WEB_PROVIDER_UNAVAILABLE` | The plugin finds no usable backend during a call. With a pinned `auto` provider the seam normally raises `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` first; this code is also the seam's answer when no provider id is pinned and no usable provider is registered. |
| `WEB_ABORTED` | The caller's `AbortSignal` fires. |
| `WEB_PROVIDER_ERROR` | A request fails, replies non-2xx, returns an unparseable body or a JSON-RPC error, or every backend fails. One error lists each failure and sets `cause` to the last failure. |

## Development

```bash
npm test
node --test test/selector.test.mjs
```

The runtime keeps zero dependencies beyond dsh's peer packages.

The suite covers selection and failover, the three vendor adapters against a local mock server, config defaults and key precedence, and one install check into a temporary `DSH_HOME`.

Each vendor adapter lives in `lib/providers/`. To support another search API, add an adapter and wire it in `index.js` and `lib/config.js`.

Tests require Node >=22.15 and `dsh` on `PATH`. `DSH_BIN` or `DSH_INSTALL_NODE_MODULES` overrides discovery.

## License

[Apache-2.0](./LICENSE) © [yelo](https://github.com/imyelo), 2026 - present
