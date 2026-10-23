/**
 * The plugin's core capability: choosing a backend and failing over.
 * DSH's seam selection is trusted; everything asserted here is our logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../scripts/test-hooks.mjs';
import { fakeChild, sleep } from './helpers.mjs';

const { WebError } = await import('@deepseek-ai/dsh-web');
const { AutoSearchProvider } = await import('../lib/selector.js');

const selector = (children, options = {}) =>
  new AutoSearchProvider({
    id: 'auto',
    children,
    strategy: options.strategy ?? 'random',
    order: options.order ?? children.map((child) => child.id),
    cooldownMs: options.cooldownMs ?? 60000,
    rateLimitCooldownMs: options.rateLimitCooldownMs ?? 600000,
    logger: options.logger,
  });

test('random: the first choice stays sticky and fails over within the same call', async () => {
  const a = fakeChild('a', {
    behavior: async () => {
      throw new Error('a down');
    },
  });
  const b = fakeChild('b');
  const provider = selector([a, b]);
  const original = Math.random;
  Math.random = () => 0.1; // first draw = a
  try {
    const first = await provider.search({ query: 'q1' });
    // a failed, so the same call fell over to b
    assert.equal(first.sources[0].url, 'https://b.example/1');
    const second = await provider.search({ query: 'q2' });
    // b is now the sticky choice
    assert.equal(second.sources[0].url, 'https://b.example/2');
  } finally {
    Math.random = original;
  }
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 2);
});

test('priority: picks by order and drills down the order on failure', async () => {
  const b = fakeChild('b', {
    behavior: async () => {
      throw new Error('b down');
    },
  });
  const a = fakeChild('a');
  const provider = selector([a, b], { strategy: 'priority', order: ['b', 'a'] });
  const result = await provider.search({ query: 'q' });
  assert.equal(result.sources[0].url, 'https://a.example/1');
  assert.equal(b.calls.length, 1);
  assert.equal(a.calls.length, 1);
});

test('round-robin: rotates the starting backend on every call', async () => {
  const a = fakeChild('a');
  const b = fakeChild('b');
  const c = fakeChild('c');
  const provider = selector([a, b, c], { strategy: 'round-robin', order: ['a', 'b', 'c'] });
  await provider.search({ query: 'q1' });
  await provider.search({ query: 'q2' });
  await provider.search({ query: 'q3' });
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(c.calls.length, 1);
});

test('Cooldown: a failed backend is skipped within cooldownMs and becomes a candidate again after it expires', async () => {
  const bad = fakeChild('bad', {
    behavior: async () => {
      throw new Error('bad down');
    },
  });
  const good = fakeChild('good');
  const provider = selector([bad, good], { strategy: 'priority', order: ['bad', 'good'], cooldownMs: 40 });
  await provider.search({ query: 'q1' });
  assert.equal(bad.calls.length, 1);
  await provider.search({ query: 'q2' });
  assert.equal(bad.calls.length, 1, 'bad should not be retried during cooldown');
  await sleep(60);
  await provider.search({ query: 'q3' });
  assert.equal(bad.calls.length, 2, 'bad should be a candidate again after cooldown expires');
});

test('Rate-limit cooldown: 402/429/432 use rateLimitCooldownMs instead of cooldownMs', async () => {
  const limited = fakeChild('limited', {
    behavior: async () => {
      throw Object.assign(new Error('429'), { status: 429, rateLimited: true });
    },
  });
  const good = fakeChild('good');
  const provider = selector([limited, good], {
    strategy: 'priority',
    order: ['limited', 'good'],
    cooldownMs: 10,
    rateLimitCooldownMs: 60000,
  });
  await provider.search({ query: 'q1' });
  await sleep(30); // regular cooldown has passed; rate-limit cooldown has not
  await provider.search({ query: 'q2' });
  assert.equal(limited.calls.length, 1);
});

test('Cancellation: pre-aborted and in-flight aborts both raise WEB_ABORTED without failover', async () => {
  const preAborted = fakeChild('pre');
  const preController = new AbortController();
  preController.abort();
  await assert.rejects(
    () => selector([preAborted]).search({ query: 'q' }, preController.signal),
    (error) => error.code === 'WEB_ABORTED',
  );
  assert.equal(preAborted.calls.length, 0);

  const hanging = fakeChild('hang', {
    behavior: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new WebError('web search aborted', 'WEB_ABORTED')));
      }),
  });
  const other = fakeChild('other');
  const provider = selector([hanging, other], { strategy: 'priority', order: ['hang', 'other'] });
  const controller = new AbortController();
  const pending = provider.search({ query: 'q' }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.code === 'WEB_ABORTED');
  assert.equal(other.calls.length, 0, 'cancellation should not trigger failover');
});

test('No available backend raises WEB_PROVIDER_UNAVAILABLE; all-cooling does not refuse the search', async () => {
  const down = fakeChild('down', { available: false });
  const unavailable = selector([down]);
  assert.equal(unavailable.available(), false);
  await assert.rejects(
    () => unavailable.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE',
  );

  const only = fakeChild('only', {
    behavior: async () => {
      throw new Error('only down');
    },
  });
  const cooling = selector([only], { strategy: 'priority', order: ['only'], cooldownMs: 60000 });
  await assert.rejects(() => cooling.search({ query: 'q1' }));
  await assert.rejects(() => cooling.search({ query: 'q2' }));
  assert.equal(only.calls.length, 2, 'still tries while everything is cooling rather than failing all artificially');
});

test('Errors: one backend keeps its original error; several aggregate into WEB_PROVIDER_ERROR with a cause', async () => {
  const single = new Error('single down');
  const only = fakeChild('only', {
    behavior: async () => {
      throw single;
    },
  });
  await assert.rejects(
    () => selector([only], { strategy: 'priority', order: ['only'] }).search({ query: 'q' }),
    (error) => error === single,
  );

  const first = new Error('A down');
  const second = new Error('B down');
  const a = fakeChild('a', {
    behavior: async () => {
      throw first;
    },
  });
  const b = fakeChild('b', {
    behavior: async () => {
      throw second;
    },
  });
  await assert.rejects(
    () => selector([a, b], { strategy: 'priority', order: ['a', 'b'] }).search({ query: 'q' }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR');
      assert.match(error.message, /every search backend failed/);
      assert.match(error.message, /a: A down/);
      assert.match(error.message, /b: B down/);
      assert.equal(error.cause, second);
      return true;
    },
  );
});
