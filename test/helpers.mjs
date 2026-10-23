/**
 * Test doubles shared by the plugin's unit tests.
 *
 * Everything here is local: a Node HTTP server on 127.0.0.1:0 for vendor
 * adapters, fake key states for the credential seam, fake selector children,
 * and a fake plugin context for `apply()` wiring. No test reaches the network.
 */
import http from 'node:http';

/** Start a local mock server on an ephemeral port; `handler(record, response)`. */
export function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const record = { method: request.method, url: request.url, headers: request.headers, body };
        try {
          record.json = body.length > 0 ? JSON.parse(body) : undefined;
        } catch {
          record.json = undefined;
        }
        requests.push(record);
        Promise.resolve(handler(record, response)).catch((error) => {
          response.statusCode = 500;
          response.end(`handler failure: ${String(error?.stack ?? error)}`);
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Write a JSON response. */
export function json(response, value, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

/** Write a plain-text response. */
export function text(response, value, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/plain', ...headers });
  response.end(value);
}

/** Write one MCP JSON-RPC message as an SSE event. */
export function sse(response, value) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A key state that resolves a fixed key ([`undefined`] = no key). */
export const keyed = (key) => ({ available: () => key !== undefined, resolve: async () => key });

/** A key state with no key anywhere. */
export const unkeyed = { available: () => false, resolve: async () => undefined };

/**
 * One fake selector child: records calls, answers with a synthetic source, and
 * can override `behavior(request, signal, callIndex)` per call.
 */
export function fakeChild(id, { available = true, behavior } = {}) {
  const calls = [];
  return {
    id,
    calls,
    available: () => available,
    async search(request, signal) {
      calls.push({ request, signal });
      if (behavior !== undefined) return behavior(request, signal, calls.length);
      return { sources: [{ url: `https://${id}.example/${calls.length}` }], truncated: false };
    },
  };
}

/**
 * Fake Loader context for `apply()` tests: captures search-provider
 * registrations, effect cleanups, and log calls; `get()` serves only the
 * services a test supplies.
 */
export function fakeCtx({ failOnId, services = {} } = {}) {
  const registrations = [];
  const effectCleanups = [];
  const logs = [];
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        if (provider.id === failOnId) throw new Error(`registration failed for ${provider.id}`);
        registrations.push(provider);
        return () => {
          const index = registrations.indexOf(provider);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
    effect(callback) {
      effectCleanups.push(callback());
    },
    get(key) {
      return services[key];
    },
    logger() {
      return {
        debug: (...args) => logs.push(['debug', ...args]),
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
      };
    },
  };
  return { ctx, registrations, effectCleanups, logs };
}

/**
 * Replace global `fetch` for one test and capture every call as
 * `{ url, headers, body, json }`. Answers with canned vendor payloads keyed by
 * URL so `apply()`-level tests can run without a server.
 */
export async function withFetch(fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    const body = typeof init.body === 'string' ? init.body : '';
    let parsed;
    try {
      parsed = body.length > 0 ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({ url: String(url), headers, body, json: parsed });
    const target = String(url);
    if (target.includes('/mcp')) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://stub.example/mcp', snippet: 'stub' }] }) }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (target.includes('tavily')) {
      return new Response(JSON.stringify({ results: [{ url: 'https://stub.example/tavily', content: 'stub' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ results: [{ url: 'https://stub.example/exa', highlights: ['stub'] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
