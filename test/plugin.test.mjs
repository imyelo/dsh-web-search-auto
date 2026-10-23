/**
 * Plugin surface: the Loader-facing config we declare, what `apply()` does with
 * it, and the credential resolution order we own. DSH's Loader lifecycle and
 * seam registry semantics are trusted and not re-tested here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../scripts/test-hooks.mjs';
import { fakeCtx, withFetch } from './helpers.mjs';

const { Config } = await import('../lib/config.js');
const plugin = await import('../index.js');

test('Config: an empty config fills in every documented default; invalid enums and out-of-range values are rejected', () => {
  const config = Config({});
  assert.equal(config.id, 'auto');
  assert.equal(config.strategy, 'random');
  assert.deepEqual(config.order, ['exa', 'tavily', 'tinyfish']);
  assert.equal(config.exposeProviders, false);
  assert.equal(config.cooldownMs, 60000);
  assert.equal(config.rateLimitCooldownMs, 600000);
  assert.equal(config.timeoutMs, 25000);
  assert.equal(config.snippetMaxChars, 400);
  assert.equal(config.providers.exa.enabled, true);
  assert.equal(config.providers.exa.apiKeyEnv, 'EXA_API_KEY');
  assert.equal(config.providers.exa.baseURL, 'https://api.exa.ai');
  assert.equal(config.providers.exa.searchType, 'auto');
  assert.equal(config.providers.exa.highlightsPerResult, 1);
  assert.equal(config.providers.tavily.keyless, true);
  assert.equal(config.providers.tavily.searchDepth, 'basic');
  assert.equal(config.providers.tavily.chunksPerSource, 3);
  assert.equal(config.providers.tavily.includeAnswer, false);
  assert.equal(config.providers.tinyfish.endpoint, 'https://agent.tinyfish.ai/mcp');
  assert.equal(config.providers.tinyfish.keyless, true);
  assert.equal(config.providers.tinyfish.domainType, 'web');

  assert.throws(() => Config({ strategy: 'nope' }));
  assert.throws(() => Config({ providers: { exa: { searchType: 'nope' } } }));
  assert.throws(() => Config({ providers: { exa: { highlightsPerResult: 0 } } }));
  assert.throws(() => Config({ providers: { tavily: { chunksPerSource: 0 } } }));
  assert.throws(() => Config({ cooldownMs: -1 }));
  assert.throws(() => Config({ timeoutMs: 0 }));
});

test('apply: registers auto by default; a custom id and exposeProviders take effect', () => {
  const byDefault = fakeCtx();
  plugin.apply(byDefault.ctx, undefined);
  assert.deepEqual(byDefault.registrations.map((provider) => provider.id), ['auto']);
  assert.equal(typeof byDefault.registrations[0].search, 'function');

  const renamed = fakeCtx();
  plugin.apply(renamed.ctx, { id: 'my-auto' });
  assert.deepEqual(renamed.registrations.map((provider) => provider.id), ['my-auto']);

  const exposed = fakeCtx();
  plugin.apply(exposed.ctx, { id: 'x', exposeProviders: true });
  assert.deepEqual(exposed.registrations.map((provider) => provider.id), ['x', 'x-exa', 'x-tavily', 'x-tinyfish']);
  assert.equal(exposed.registrations.find((provider) => provider.id === 'x-tavily').available(), true);
});

test('apply: disabled backends are not built or exposed; disabling all registers nothing and warns', () => {
  const partial = fakeCtx();
  plugin.apply(partial.ctx, {
    exposeProviders: true,
    providers: { exa: { enabled: false }, tinyfish: { enabled: false } },
  });
  assert.deepEqual(partial.registrations.map((provider) => provider.id), ['auto', 'auto-tavily']);

  const none = fakeCtx();
  plugin.apply(none.ctx, {
    providers: { exa: { enabled: false }, tavily: { enabled: false }, tinyfish: { enabled: false } },
  });
  assert.equal(none.registrations.length, 0);
  assert.ok(none.logs.some(([level, message]) => level === 'warn' && /no search provider/.test(String(message))));
});

test('apply: effect cleanup unregisters everything; a mid-way registration failure rolls back registered entries', () => {
  const { ctx, registrations, effectCleanups } = fakeCtx();
  plugin.apply(ctx, { exposeProviders: true });
  assert.equal(registrations.length, 4);
  effectCleanups[0]();
  assert.equal(registrations.length, 0);
  effectCleanups[0](); // repeated cleanup is harmless
  assert.equal(registrations.length, 0);

  const failing = fakeCtx({ failOnId: 'auto-tavily' });
  assert.throws(() => plugin.apply(failing.ctx, { exposeProviders: true }), /registration failed/);
  assert.equal(failing.registrations.length, 0);
});

test('Credential order: literal > managed credential service > launch environment', async () => {
  const setKey = (value) => {
    process.env.WS_TEST_KEY = value;
  };
  const clearKey = () => {
    delete process.env.WS_TEST_KEY;
  };
  const config = {
    strategy: 'priority',
    order: ['tavily'],
    providers: {
      exa: { enabled: false },
      tinyfish: { enabled: false },
      tavily: { keyless: false, apiKeyEnv: 'WS_TEST_KEY' },
    },
  };
  const credentials = { resolve: async () => ({ value: 'cred-secret' }) };

  try {
    setKey('env-secret');
    await withFetch(async (calls) => {
      const literal = fakeCtx({ services: { credentials } });
      plugin.apply(literal.ctx, { ...config, providers: { ...config.providers, tavily: { ...config.providers.tavily, apiKey: 'literal-secret' } } });
      await literal.registrations[0].search({ query: 'q' });
      assert.equal(calls[0].headers.get('authorization'), 'Bearer literal-secret');
    });

    await withFetch(async (calls) => {
      const managed = fakeCtx({ services: { credentials } });
      plugin.apply(managed.ctx, config);
      await managed.registrations[0].search({ query: 'q' });
      assert.equal(calls[0].headers.get('authorization'), 'Bearer cred-secret');
    });

    await withFetch(async (calls) => {
      const launch = fakeCtx();
      plugin.apply(launch.ctx, config);
      await launch.registrations[0].search({ query: 'q' });
      assert.equal(calls[0].headers.get('authorization'), 'Bearer env-secret');
    });
  } finally {
    clearKey();
  }
});

test('apply: unknown ids in order are skipped and the remaining order is honored', async () => {
  await withFetch(async (calls) => {
    const { ctx, registrations } = fakeCtx();
    plugin.apply(ctx, {
      strategy: 'priority',
      order: ['does-not-exist', 'tinyfish'],
      providers: { exa: { enabled: false } },
    });
    const result = await registrations[0].search({ query: 'q' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/mcp$/);
    assert.deepEqual(result.sources, [{ url: 'https://stub.example/mcp', snippet: 'stub' }]);
  });
});
