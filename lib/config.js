/**
 * Loader-facing configuration schema for `dsh-web-search-auto`.
 *
 * Everything is optional and defaulted: a Loader row may omit `config`
 * entirely, and a user-level override replaces the WHOLE `config` mapping, so
 * no field may be required for the plugin to work (see plugins/README.md §6).
 *
 * @module dsh-web-search-auto/config
 */
import z from '@deepseek-ai/schemastery';

/** Strategies the composite provider can use to order its children. */
export const STRATEGIES = ['random', 'priority', 'round-robin'];

/** Default child order, used by `priority` and as the display order elsewhere. */
export const DEFAULT_ORDER = ['exa', 'tavily', 'tinyfish'];

/** The credential fields every backend shares: a literal key plus the reference name. */
function credentialFields(defaultEnv) {
  return {
    apiKey: z
      .string()
      .role('secret')
      .description(
        `Literal API key. Leave empty to resolve ${defaultEnv} from the credential store, .env files, or the process environment.`,
      ),
    apiKeyEnv: z
      .string()
      .default(defaultEnv)
      .description(`Credential reference to resolve when apiKey is empty. Defaults to ${defaultEnv}.`),
  };
}

export const Config = z.object({
  id: z
    .string()
    .default('auto')
    .description('Provider id the composite registers under in the ctx.web search registry.'),
  strategy: z
    .union(STRATEGIES)
    .default('random')
    .description(
      'random: pick one usable backend and keep it until it fails (opencode-style); priority: walk `order` top-down; round-robin: rotate the starting backend per call.',
    ),
  order: z
    .array(z.string())
    .default(DEFAULT_ORDER)
    .description('Preference order for priority and the rotation sequence for round-robin; random ignores it.'),
  exposeProviders: z
    .boolean()
    .default(false)
    .description('Also register every enabled backend as its own provider, named `<id>-<backend>`, for manual selection.'),
  cooldownMs: z
    .number()
    .min(0)
    .step(1)
    .default(60_000)
    .description('How long a backend that failed is skipped before it is a normal candidate again.'),
  rateLimitCooldownMs: z
    .number()
    .min(0)
    .step(1)
    .default(600_000)
    .description('How long a backend that answered 429/402/432 is skipped.'),
  timeoutMs: z.number().min(1).step(1).default(25_000).description('Per-request timeout forwarded to each backend.'),
  snippetMaxChars: z
    .number()
    .min(0)
    .step(1)
    .default(400)
    .description('Collapse and cap source snippets at this many characters, including the ellipsis (0 disables the cap).'),
  providers: z.object({
    exa: z.object({
      enabled: z.boolean().default(true).description('Enable the Exa backend.'),
      ...credentialFields('EXA_API_KEY'),
      baseURL: z.string().default('https://api.exa.ai').description('Exa REST base URL; `/search` is appended.'),
      searchType: z.union(['auto', 'keyword', 'neural']).default('auto').description('Exa retrieval mode.'),
      highlightsPerResult: z
        .number()
        .min(1)
        .step(1)
        .default(1)
        .description('Highlight snippets requested per result; only the first non-blank one becomes the snippet.'),
      numResults: z
        .number()
        .min(1)
        .step(1)
        .description('Result count sent to Exa when the caller does not cap it via maxResults.'),
    }),
    tavily: z.object({
      enabled: z.boolean().default(true).description('Enable the Tavily backend.'),
      ...credentialFields('TAVILY_API_KEY'),
      baseURL: z.string().default('https://api.tavily.com').description('Tavily REST base URL; `/search` is appended.'),
      keyless: z
        .boolean()
        .default(true)
        .description('Fall back to Tavily keyless access (`X-Tavily-Access-Mode: keyless`) when no key is configured.'),
      searchDepth: z.union(['basic', 'advanced']).default('basic').description('Tavily search depth.'),
      chunksPerSource: z.number().min(1).step(1).default(3).description('Tavily chunks_per_source.'),
      includeAnswer: z.boolean().default(false).description('Ask Tavily for a generated answer and expose it as `content`.'),
    }),
    tinyfish: z.object({
      enabled: z.boolean().default(true).description('Enable the TinyFish backend.'),
      ...credentialFields('TINYFISH_API_KEY'),
      endpoint: z
        .string()
        .default('https://agent.tinyfish.ai/mcp')
        .description('TinyFish MCP-over-HTTP endpoint.'),
      keyless: z
        .boolean()
        .default(true)
        .description('Fall back to TinyFish keyless access (`X-TinyFish-Access-Mode: keyless`) when no key is configured.'),
      domainType: z
        .union(['web', 'news', 'research_paper'])
        .default('web')
        .description('TinyFish search domain.'),
      language: z.string().description('Optional language code forwarded to TinyFish.'),
      location: z.string().description('Optional country code forwarded to TinyFish.'),
    }),
  }),
});
