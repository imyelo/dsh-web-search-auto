/**
 * `dsh-web-search-auto`: one composite `ctx.web` search provider that fans
 * out across a pool of backends (Exa, Tavily, TinyFish) with sticky-random
 * selection and automatic failover.
 *
 * The dsh web seam selects exactly one registered provider id at execution
 * time and has no cascade of its own (see @deepseek-ai/dsh-web README, "Provider
 * selection"), so the cascade lives inside this one provider: `web.searchProvider`
 * points at `auto` (configurable via `id`), and `auto` decides which backend runs.
 *
 * @module dsh-web-search-auto
 */
import { Config, DEFAULT_ORDER } from './lib/config.js';
import { KeyState } from './lib/keys.js';
import { AutoSearchProvider } from './lib/selector.js';
import { ExaSearchProvider } from './lib/providers/exa.js';
import { TavilySearchProvider } from './lib/providers/tavily.js';
import { TinyFishSearchProvider } from './lib/providers/tinyfish.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-auto';

/** The web seam this provider registers into. */
export const inject = ['web'];

export { Config };

const DEFAULT_STRATEGY = 'random';
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_SNIPPET_MAX_CHARS = 400;
const SEARCH_TYPES = new Set(['auto', 'keyword', 'neural']);
const DOMAIN_TYPES = new Set(['web', 'news', 'research_paper']);

/** Non-empty trimmed string, or the fallback. */
function pickText(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Finite number, or the fallback. */
function pickNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A provider block is enabled unless it explicitly says otherwise. */
function isEnabled(block) {
  return block === undefined || block.enabled !== false;
}

/** Best-effort named logger; a missing logger never breaks search. */
function createLogger(ctx) {
  let logger;
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger(name) : undefined;
  } catch {
    logger = undefined;
  }
  const emit = (type, format, ...params) => {
    try {
      logger?.[type]?.(format, ...params);
    } catch {
      // Diagnostics must never take the search path down.
    }
  };
  return {
    debug: (format, ...params) => emit('debug', format, ...params),
    info: (format, ...params) => emit('info', format, ...params),
    warn: (format, ...params) => emit('warn', format, ...params),
  };
}

/** Child provider ids in preference order: configured first, then the rest. */
function resolveOrder(order, present) {
  const preferred = Array.isArray(order) ? order.filter((entry) => typeof entry === 'string') : DEFAULT_ORDER;
  const ordered = preferred.filter((entry) => present.includes(entry));
  for (const entry of present) if (!ordered.includes(entry)) ordered.push(entry);
  return ordered;
}

/** Wrap a backend so it can also be registered under its own provider id. */
class ExposedProvider {
  constructor(id, inner) {
    this.id = id;
    this.inner = inner;
  }

  available() {
    return this.inner.available();
  }

  search(request, signal) {
    return this.inner.search(request, signal);
  }
}

/**
 * Build one backend adapter per enabled provider block.
 *
 * @param {object} ctx plugin context
 * @param {object} providers provider config blocks (exa/tavily/tinyfish)
 * @param {{timeoutMs: number, snippetMaxChars: number}} shared shared settings
 * @returns {Array<{id: string, provider: object}>}
 */
function buildBackends(ctx, providers, shared) {
  const backends = [];

  if (isEnabled(providers.exa)) {
    const block = providers.exa ?? {};
    backends.push({
      id: 'exa',
      provider: new ExaSearchProvider({
        enabled: true,
        keyState: new KeyState(ctx, {
          apiKey: block.apiKey,
          apiKeyEnv: pickText(block.apiKeyEnv, 'EXA_API_KEY'),
          keyless: false,
        }),
        baseURL: pickText(block.baseURL, 'https://api.exa.ai'),
        searchType: SEARCH_TYPES.has(block.searchType) ? block.searchType : 'auto',
        highlightsPerResult: pickNumber(block.highlightsPerResult, 1),
        numResults: Number.isInteger(block.numResults) ? block.numResults : undefined,
        timeoutMs: shared.timeoutMs,
        snippetMaxChars: shared.snippetMaxChars,
      }),
    });
  }

  if (isEnabled(providers.tavily)) {
    const block = providers.tavily ?? {};
    backends.push({
      id: 'tavily',
      provider: new TavilySearchProvider({
        enabled: true,
        keyState: new KeyState(ctx, {
          apiKey: block.apiKey,
          apiKeyEnv: pickText(block.apiKeyEnv, 'TAVILY_API_KEY'),
          keyless: block.keyless !== false,
        }),
        baseURL: pickText(block.baseURL, 'https://api.tavily.com'),
        keyless: block.keyless !== false,
        searchDepth: block.searchDepth === 'advanced' ? 'advanced' : 'basic',
        chunksPerSource: pickNumber(block.chunksPerSource, 3),
        includeAnswer: block.includeAnswer === true,
        timeoutMs: shared.timeoutMs,
        snippetMaxChars: shared.snippetMaxChars,
      }),
    });
  }

  if (isEnabled(providers.tinyfish)) {
    const block = providers.tinyfish ?? {};
    backends.push({
      id: 'tinyfish',
      provider: new TinyFishSearchProvider({
        enabled: true,
        keyState: new KeyState(ctx, {
          apiKey: block.apiKey,
          apiKeyEnv: pickText(block.apiKeyEnv, 'TINYFISH_API_KEY'),
          keyless: block.keyless !== false,
        }),
        endpoint: pickText(block.endpoint, 'https://agent.tinyfish.ai/mcp'),
        keyless: block.keyless !== false,
        domainType: DOMAIN_TYPES.has(block.domainType) ? block.domainType : 'web',
        language: pickText(block.language, undefined),
        location: pickText(block.location, undefined),
        timeoutMs: shared.timeoutMs,
        snippetMaxChars: shared.snippetMaxChars,
      }),
    });
  }

  return backends;
}

/**
 * Register the composite provider with the web seam.
 *
 * @param {object} ctx plugin context
 * @param {object|undefined} config this Loader row's `config` mapping (may be absent)
 */
export function apply(ctx, config) {
  const options = config ?? {};
  const logger = createLogger(ctx);
  const id = pickText(options.id, 'auto');
  const shared = {
    timeoutMs: pickNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    snippetMaxChars: pickNumber(options.snippetMaxChars, DEFAULT_SNIPPET_MAX_CHARS),
  };
  const backends = buildBackends(ctx, options.providers ?? {}, shared);
  if (backends.length === 0) {
    logger.warn('all backends are disabled; no search provider is registered');
    return;
  }
  const strategy =
    options.strategy === 'priority' || options.strategy === 'round-robin' ? options.strategy : DEFAULT_STRATEGY;
  const provider = new AutoSearchProvider({
    id,
    children: backends.map((backend) => backend.provider),
    strategy,
    order: resolveOrder(options.order, backends.map((backend) => backend.id)),
    cooldownMs: pickNumber(options.cooldownMs, DEFAULT_COOLDOWN_MS),
    rateLimitCooldownMs: pickNumber(options.rateLimitCooldownMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
    logger,
  });

  const registrations = [provider];
  if (options.exposeProviders === true) {
    for (const backend of backends) registrations.push(new ExposedProvider(`${id}-${backend.id}`, backend.provider));
  }

  // Registered inside our own effect so unloading this plugin disposes the
  // providers, even though the seam also ties them to the web service's fiber.
  ctx.effect(() => {
    const disposers = [];
    try {
      for (const candidate of registrations) disposers.push(ctx.web.registerSearchProvider(candidate));
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Nothing useful to do while unwinding a registration failure.
        }
      }
      throw error;
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // Double disposal is harmless.
        }
      }
    };
  });
  logger.info('search provider "%s" registered (strategy=%s, backends=%s)', id, strategy, backends.map((backend) => backend.id).join(','));
}
