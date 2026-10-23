# @local/web-search-auto

English | [中文](README.zh.md)

A `ctx.web` search provider that puts three backends — Exa, Tavily and TinyFish — behind one provider id. It selects one usable backend per call (sticky random, fixed priority, or round-robin) and fails over inside the same call when that backend errors or is throttled. Use it when the harness can name only one search provider but the deployment has more than one vendor to spend and fall back on.

It handles search only, across the three vendor APIs. It does not fetch pages, choose a backend per query, or report usage.

## Install

The package is `@local/web-search-auto`. It is installed by path because it is not published.

```bash
git clone https://github.com/imyelo/dsh-web-search-auto.git
cd dsh-web-search-auto
dsh plugin --profile web add "$PWD"
```

The bundle inserts the loader row `web-search-auto` and registers provider id `auto`. Select it in the same profile's patch file:

```yaml
- id: web
  config:
    searchProvider: auto      # equals this plugin's config.id
    fetchProvider: http
```

A profile override replaces the whole `config` mapping, so restate every field the row needs. A changed provider id or plugin code takes effect on the next process start. The official `@deepseek-ai/dsh-web-search-exa` registers `exa`; this plugin registers `auto`, so both can be loaded in one profile.

## Options

Every field has a default; the loader row may omit `config` entirely.

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `id` | string | `auto` | Provider id registered with the web service; `web.searchProvider` names it. |
| `strategy` | `random` \| `priority` \| `round-robin` | `random` | Backend order used for one call. |
| `order` | string[] | `[exa, tavily, tinyfish]` | Preference order for `priority` and tie-breaking; unknown ids are ignored. |
| `exposeProviders` | boolean | `false` | Also register each enabled backend as `<id>-<backend>`. |
| `cooldownMs` | number | `60000` | How long a failed backend is skipped. |
| `rateLimitCooldownMs` | number | `600000` | How long a backend that answered 402, 429 or 432 is skipped. |
| `timeoutMs` | number | `25000` | Per-request timeout for each backend. |
| `snippetMaxChars` | number | `400` | Collapse whitespace and cap snippets at this length; `0` disables the cap. |
| `providers.<backend>.enabled` | boolean | `true` | Whether the backend is built and registered. |
| `providers.<backend>.apiKey` | string | unset | Literal key; highest precedence. |
| `providers.<backend>.apiKeyEnv` | string | `EXA_API_KEY`, `TAVILY_API_KEY`, `TINYFISH_API_KEY` | Credential reference resolved from the credential service, then the launch environment. |
| `providers.exa.baseURL` | string | `https://api.exa.ai` | Endpoint base; `/search` is appended. |
| `providers.exa.searchType` | `auto` \| `keyword` \| `neural` | `auto` | Exa retrieval mode. |
| `providers.exa.highlightsPerResult` | number | `1` | Highlight sentences requested per result. |
| `providers.exa.numResults` | number | unset | Result count sent when the request has no `maxResults`. |
| `providers.tavily.baseURL` | string | `https://api.tavily.com` | Endpoint base; `/search` is appended. |
| `providers.tavily.keyless` | boolean | `true` | Use Tavily keyless access when no key resolves. |
| `providers.tavily.searchDepth` | `basic` \| `advanced` | `basic` | Tavily search depth. |
| `providers.tavily.chunksPerSource` | number | `3` | Tavily `chunks_per_source`. |
| `providers.tavily.includeAnswer` | boolean | `false` | Ask Tavily for an answer and expose it as `content`. |
| `providers.tinyfish.endpoint` | string | `https://agent.tinyfish.ai/mcp` | TinyFish MCP endpoint. |
| `providers.tinyfish.keyless` | boolean | `true` | Use TinyFish keyless access when no key resolves. |
| `providers.tinyfish.domainType` | `web` \| `news` \| `research_paper` | `web` | TinyFish search domain. |
| `providers.tinyfish.language` | string | unset | Optional language code. |
| `providers.tinyfish.location` | string | unset | Optional country code. |

## Behavior

### Selection

`random` draws one usable backend and reuses it across calls; the choice is replaced only when that backend errors or enters cooldown. `priority` takes the first usable backend in `order`. `round-robin` rotates the starting position in `order` once per call. A backend is usable when it is enabled and either its credentials resolve locally or it runs keyless; no network check runs. To pin one backend, set `strategy: priority` with a single-entry `order`, or disable the other backends.

### Failover and cooldown

A failed backend enters cooldown and the same call tries the next candidate, returning the first success. When every candidate is cooling, the call ignores cooldowns instead of returning no result. A caller `AbortSignal` throws `WEB_ABORTED` immediately and stops failover. Two or more failures produce one `WEB_PROVIDER_ERROR` whose message lists each backend; a single failing backend rethrows its own error.

### Credentials

Each search resolves the key in this order: literal `apiKey`, the credential service, the launch environment named by `apiKeyEnv`. A rotated key reaches the next search. Keyless Tavily and TinyFish need no key; Exa has no keyless mode. `available()` answers locally: keyless backends are usable, while a keyed backend stays optimistic until the background credential probe finishes.

### Results

Each backend result becomes a source with `url`, optional `title`, `snippet` and `publishedAt`. `content` is set only when a backend returns prose: Tavily's answer with `includeAnswer`, or a TinyFish payload that is not JSON. Results without a URL are dropped. `maxResults` is sent to Exa and Tavily as a result count and enforced by the web service for every backend; the service sets `truncated` when it cuts sources.

## Limits

- Search only. Page retrieval belongs to the web service's fetch provider, such as `http`.
- One provider id. The model-facing `web_search` tool cannot choose a backend per query; selection is configuration.
- Exa requires a key; its REST API has no keyless mode. A missing key makes that backend unavailable.
- Keyless Tavily and TinyFish run on lower vendor quotas. A throttled backend answers 402, 429 or 432 and is skipped for `rateLimitCooldownMs`.
- Cooldowns live in process memory. A restart forgets them, and each profile process keeps its own.
- Sticky `random` sends every search to one backend until that backend fails; it does not balance load across calls.
- A backend can return fewer sources than requested: adapters drop results without a URL. The service truncates only to `maxResults`.
- `available()` can report a keyed backend usable before the credential probe finishes; a search in that window can fail with `WEB_PROVIDER_CREDENTIAL_MISSING`.
- Requests use bare `fetch`; the plugin has no proxy or TLS options of its own. Redirects are rejected before the target is contacted.

## Format and errors

| Backend | Request | Auth | Keyless |
| --- | --- | --- | --- |
| Exa | `POST {baseURL}/search` | `Authorization: Bearer <key>` | Not available |
| Tavily | `POST {baseURL}/search` | `Authorization: Bearer <key>` | `X-Tavily-Access-Mode: keyless` |
| TinyFish | `POST {endpoint}` with MCP `tools/call` `search`; keyed requests `initialize` first | `X-API-Key` | `X-TinyFish-Access-Mode: keyless` |

| Result field | Exa | Tavily | TinyFish |
| --- | --- | --- | --- |
| `url` | `results[].url` | `results[].url` | `results[].url` in the JSON text payload |
| `title` | `title` | `title` | `title` |
| `snippet` | First non-blank highlight | `content` | `snippet` or `content` |
| `publishedAt` | `publishedDate` | `published_date` or `publishedDate` | `date` |
| `content` | — | `answer` with `includeAnswer` | Non-JSON text payload |

| Code | Raised when |
| --- | --- |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | A backend needs a key and none resolves: Exa always, Tavily or TinyFish with `keyless: false`. |
| `WEB_PROVIDER_UNAVAILABLE` | No backend is usable at call time. |
| `WEB_ABORTED` | The caller's `AbortSignal` fires. |
| `WEB_PROVIDER_ERROR` | A request fails, replies non-2xx, returns an unparseable body or a JSON-RPC error, or every backend fails (aggregate; `cause` is the last error). |

A `web.searchProvider` that names an unregistered id is the web service's error, not this provider's.

## Development

```bash
npm test
node --test test/selector.test.mjs
```

The suite covers selection and failover, the three vendor adapters against a local mock server, config defaults and credential precedence, and one install smoke into a temporary `DSH_HOME`. The harness's own loader and web service behavior are not retested. There are no dependencies and no lockfile. Tests need Node 22.15 or newer and `dsh` on `PATH`; `DSH_BIN` or `DSH_INSTALL_NODE_MODULES` overrides discovery.

## License

No license is declared for this repository.
