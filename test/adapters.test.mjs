/**
 * Vendor adapters: the request shape we send and the mapping we return.
 * Vendor contracts are the part we own; a local mock server stands in for
 * every external endpoint so the suite never touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../scripts/test-hooks.mjs';
import { startServer, json, text, sse, keyed, unkeyed } from './helpers.mjs';

const { ExaSearchProvider } = await import('../lib/providers/exa.js');
const { TavilySearchProvider } = await import('../lib/providers/tavily.js');
const { TinyFishSearchProvider, parseRpcMessage } = await import('../lib/providers/tinyfish.js');
const { normalizeSnippet, isIsoDate, trimBaseUrl, request: httpRequest } = await import('../lib/http.js');

const exa = (server, overrides = {}) =>
  new ExaSearchProvider({
    enabled: true,
    keyState: keyed('exa-key'),
    baseURL: `${server.base}/exa/`,
    searchType: 'neural',
    highlightsPerResult: 2,
    numResults: 5,
    timeoutMs: 2000,
    snippetMaxChars: 24,
    ...overrides,
  });

const tavily = (server, overrides = {}) =>
  new TavilySearchProvider({
    enabled: true,
    keyState: unkeyed,
    baseURL: `${server.base}/tavily/`,
    keyless: true,
    searchDepth: 'advanced',
    chunksPerSource: 5,
    includeAnswer: true,
    timeoutMs: 2000,
    snippetMaxChars: 400,
    ...overrides,
  });

const tinyfish = (server, overrides = {}) =>
  new TinyFishSearchProvider({
    enabled: true,
    keyState: unkeyed,
    endpoint: `${server.base}/mcp`,
    keyless: true,
    domainType: 'news',
    language: 'en',
    location: 'US',
    timeoutMs: 2000,
    snippetMaxChars: 400,
    ...overrides,
  });

const rpcResult = (textValue) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: textValue }] } });

test('Exa: request shape, result mapping and maxResults override', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/exa/search') {
      json(response, {
        results: [
          { url: 'https://a.example/1', title: 'A', highlights: ['  one   two  ', 'second'], publishedDate: '2024-01-02T03:04:05Z' },
          { title: 'no url', highlights: ['x'] },
          { url: 'https://b.example/2', highlights: ['   '] },
          { url: 'https://c.example/3', highlights: ['alpha beta gamma delta epsilon zeta theta iota kappa'], publishedDate: 'not-a-date' },
        ],
      });
    } else {
      text(response, 'no route', 404);
    }
  });
  try {
    const provider = exa(server);
    assert.equal(provider.id, 'exa');
    assert.equal(provider.available(), true);
    const result = await provider.search({ query: 'q' });
    const sent = server.requests[0];
    assert.equal(sent.url, '/exa/search');
    assert.equal(sent.headers.authorization, 'Bearer exa-key');
    assert.deepEqual(sent.json, {
      query: 'q',
      type: 'neural',
      contents: { highlights: { highlightsPerUrl: 2 } },
      numResults: 5,
    });
    assert.deepEqual(result.sources, [
      { url: 'https://a.example/1', title: 'A', snippet: 'one two', publishedAt: '2024-01-02T03:04:05Z' },
      { url: 'https://b.example/2' },
      { url: 'https://c.example/3', snippet: 'alpha beta gamma delta…' },
    ]);

    await provider.search({ query: 'q', maxResults: 3 });
    assert.equal(server.requests[1].json.numResults, 3, 'request.maxResults should override numResults');
  } finally {
    await server.close();
  }
});

test('Exa: availability conditions and missing-key errors', async () => {
  const base = { base: 'http://127.0.0.1:9' };
  assert.equal(exa(base).available(), true);
  assert.equal(exa(base, { enabled: false }).available(), false);
  assert.equal(exa(base, { keyState: unkeyed }).available(), false);
  assert.equal(exa(base, { baseURL: 'not a url' }).available(), false);
  assert.equal(exa(base, { highlightsPerResult: 0 }).available(), false);
  assert.equal(exa(base, { numResults: 0 }).available(), false);

  await assert.rejects(
    () => exa(base, { keyState: unkeyed }).search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
  );
});

test('Tavily: keyless request shape and result mapping', async () => {
  const server = await startServer((_request, response) =>
    json(response, {
      answer: '  A short answer  ',
      results: [
        { url: 'https://t.example/1', title: 'T', content: '  some   text ', published_date: '2024-05-06' },
        { url: '', content: 'no url' },
      ],
    }),
  );
  try {
    const result = await tavily(server).search({ query: 'q', maxResults: 7 });
    const sent = server.requests[0];
    assert.equal(sent.url, '/tavily/search');
    assert.equal(sent.headers['x-tavily-access-mode'], 'keyless');
    assert.equal(sent.headers.authorization, undefined);
    assert.deepEqual(sent.json, {
      query: 'q',
      search_depth: 'advanced',
      chunks_per_source: 5,
      max_results: 7,
      include_answer: true,
    });
    assert.equal(result.content, 'A short answer');
    assert.deepEqual(result.sources, [
      { url: 'https://t.example/1', title: 'T', snippet: 'some text', publishedAt: '2024-05-06' },
    ]);
  } finally {
    await server.close();
  }
});

test('Tavily: keyed headers, omitted optional fields and missing-key errors when keyless:false', async () => {
  const server = await startServer((_request, response) =>
    json(response, { results: [{ url: 'https://t.example/2', content: 'x' }] }),
  );
  try {
    const result = await tavily(server, { keyState: keyed('tv-key'), keyless: false, includeAnswer: false }).search({
      query: 'q',
    });
    const sent = server.requests[0];
    assert.equal(sent.headers.authorization, 'Bearer tv-key');
    assert.equal(sent.headers['x-tavily-access-mode'], undefined);
    assert.equal(Object.hasOwn(sent.json, 'max_results'), false);
    assert.equal(Object.hasOwn(sent.json, 'include_answer'), false);
    assert.equal(Object.hasOwn(result, 'content'), false);

    const base = { base: 'http://127.0.0.1:9' };
    assert.equal(tavily(base, { keyless: false }).available(), false);
    await assert.rejects(
      () => tavily(base, { keyless: false }).search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
    );
  } finally {
    await server.close();
  }
});

test('TinyFish: keyless request params, JSON/SSE decoding and omitted optional params', async () => {
  let mode = 'json';
  const payload = JSON.stringify({
    results: [{ url: 'https://tf.example/1', title: 'TF', snippet: '  tf   snippet ', date: '2024-06-07' }],
  });
  const server = await startServer((_request, response) => {
    if (mode === 'json') {
      json(response, rpcResult(payload));
      mode = 'sse';
    } else {
      sse(response, rpcResult(payload));
    }
  });
  try {
    const first = await tinyfish(server).search({ query: 'q' });
    const sent = server.requests[0];
    assert.equal(sent.headers['x-tinyfish-access-mode'], 'keyless');
    assert.equal(sent.headers['x-api-key'], undefined);
    assert.deepEqual(sent.json, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query: 'q', domain_type: 'news', language: 'en', location: 'US' },
      },
    });
    assert.deepEqual(first.sources, [
      { url: 'https://tf.example/1', title: 'TF', snippet: 'tf snippet', publishedAt: '2024-06-07' },
    ]);

    const second = await tinyfish(server).search({ query: 'q' });
    assert.deepEqual(second.sources, first.sources, 'SSE response should decode to the same results');

    const minimal = await tinyfish(server, { language: '', location: undefined, domainType: '' }).search({ query: 'q' });
    assert.deepEqual(server.requests[2].json.params.arguments, { query: 'q' });
    assert.deepEqual(minimal.sources, first.sources);
  } finally {
    await server.close();
  }
});

test('TinyFish: keyed session initialization, reuse, and one re-initialization after 404', async () => {
  const sequence = [];
  let initializeCount = 0;
  let searchCalls = 0;
  const server = await startServer((request, response) => {
    sequence.push(request.json?.method);
    if (request.json?.method === 'initialize') {
      initializeCount += 1;
      return json(response, { jsonrpc: '2.0', id: request.json.id, result: {} }, 200, {
        'mcp-session-id': `sess-${initializeCount}`,
      });
    }
    if (request.json?.method === 'notifications/initialized') {
      response.writeHead(202);
      return response.end('');
    }
    if (request.json?.method === 'tools/call') {
      searchCalls += 1;
      if (searchCalls === 1) return text(response, 'session expired', 404);
      return json(response, rpcResult(JSON.stringify({ results: [{ url: 'https://tf.example/keyed', snippet: 'keyed' }] })));
    }
    return text(response, 'unknown', 400);
  });
  try {
    const provider = tinyfish(server, { keyState: keyed('tf-key'), keyless: false });
    const first = await provider.search({ query: 'q1' });
    assert.equal(first.sources[0].url, 'https://tf.example/keyed');
    const second = await provider.search({ query: 'q2' });
    assert.equal(second.sources[0].url, 'https://tf.example/keyed');
    assert.deepEqual(sequence, [
      'initialize',
      'notifications/initialized',
      'tools/call', // 404 means the old session is invalid
      'initialize',
      'notifications/initialized',
      'tools/call', // retry succeeds
      'tools/call', // the second search reuses sess-2
    ]);
    assert.equal(server.requests[0].headers['x-api-key'], 'tf-key');
    assert.equal(server.requests.at(-1).headers['mcp-session-id'], 'sess-2');
  } finally {
    await server.close();
  }
});

test('Vendor error mapping: HTTP status, JSON-RPC error, malformed JSON, isError', async () => {
  const limited = await startServer((_request, response) => json(response, { detail: { error: 'slow down' } }, 429));
  try {
    await assert.rejects(
      () => tavily(limited).search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && error.status === 429 && error.rateLimited === true,
    );
  } finally {
    await limited.close();
  }

  const rpc = await startServer((_request, response) =>
    json(response, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
  );
  try {
    await assert.rejects(
      () => tinyfish(rpc).search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && error.rpcCode === -32000 && /boom/.test(error.message),
    );
  } finally {
    await rpc.close();
  }

  const malformed = await startServer((_request, response) => text(response, '{not json'));
  try {
    await assert.rejects(
      () => exa(malformed).search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && /unprocessable response body/.test(error.message),
    );
  } finally {
    await malformed.close();
  }

  const isError = await startServer((_request, response) =>
    json(response, { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'bad thing' }] } }),
  );
  try {
    await assert.rejects(
      () => tinyfish(isError).search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && /bad thing/.test(error.message),
    );
  } finally {
    await isError.close();
  }
});

test('HTTP utilities: snippet collapsing/truncation, ISO dates, baseURL trimming', () => {
  assert.equal(normalizeSnippet('  one \n\t two  ', 400), 'one two');
  assert.equal(normalizeSnippet('alpha beta gamma delta epsilon zeta theta iota kappa', 24), 'alpha beta gamma delta…');
  assert.equal(normalizeSnippet('  ', 400), undefined);
  assert.equal(normalizeSnippet(42, 400), undefined);
  assert.equal(normalizeSnippet('abcdefghij', 0), 'abcdefghij');
  for (const value of ['2024-01-02', '2024-01-02T03:04:05Z', '2024-01-02 03:04', '2024-01-02T03:04:05.123+08:00']) {
    assert.equal(isIsoDate(value), true, value);
  }
  for (const value of ['not-a-date', '20240102', 20240102, undefined, '']) {
    assert.equal(isIsoDate(value), false, String(value));
  }
  assert.equal(trimBaseUrl('https://example.com///'), 'https://example.com');
  assert.equal(trimBaseUrl(undefined), '');
  assert.equal(parseRpcMessage(`data: ${JSON.stringify({ id: 1, result: {} })}\n`).id, 1);
});

test('Timeout: timeoutMs is forwarded to backend requests', async () => {
  const server = await startServer(() => {});
  try {
    await assert.rejects(
      () => httpRequest('Test', `${server.base}/slow`, { method: 'GET' }, undefined, 60),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && /timed out after 60ms/.test(error.message),
    );
  } finally {
    await server.close();
  }
});
