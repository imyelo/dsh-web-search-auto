/**
 * TinyFish backend for the composite provider: MCP-over-HTTP (`tools/call`
 * `search`). TinyFish accepts keyless requests, and when a key IS configured the
 * request must first `initialize` and carry the returned `Mcp-Session-Id`.
 * Responses may be plain JSON or SSE, so both are decoded.
 *
 * @module @local/web-search-auto/providers/tinyfish
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { isIsoDate, normalizeSnippet, request as httpRequest, trimBaseUrl } from '../http.js';

/** Stable backend id (also its suffix when `exposeProviders` is on). */
export const TINYFISH_ID = 'tinyfish';

const USER_AGENT = 'dsh-web-search-auto/1.0.0';
const CLIENT_INFO = { name: 'dsh-web-search-auto', version: '1.0.0' };
const PROTOCOL_VERSION = '2025-06-18';

/** Extract the JSON-RPC response from a JSON or SSE body. */
export function parseRpcMessage(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const messages = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      // Fall through to SSE decoding.
    }
  }
  if (messages.length === 0) {
    const data = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    const joined = data.join('\n').trim();
    if (joined.length > 0) {
      try {
        messages.push(JSON.parse(joined));
      } catch {
        for (const chunk of data) {
          try {
            messages.push(JSON.parse(chunk));
          } catch {
            // Ignore non-JSON SSE payloads (heartbeats, comments).
          }
        }
      }
    }
  }
  return messages.find((message) => message?.result !== undefined || message?.error !== undefined) ?? messages[0];
}

/** Concatenate the text blocks of one MCP tool result. */
function toolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n');
}

/** Parse the JSON payload TinyFish puts inside its text block; fences tolerated. */
function parseJsonPayload(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (stripped.length === 0) return undefined;
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

/** Map TinyFish results to the seam's normalized search result. */
function mapToolText(text, snippetMaxChars) {
  const payload = parseJsonPayload(text);
  const results = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : undefined;
  if (results === undefined) {
    const content = text.trim();
    return content.length === 0 ? { sources: [], truncated: false } : { content, sources: [], truncated: false };
  }
  const sources = [];
  for (const result of results) {
    if (typeof result?.url !== 'string' || result.url.length === 0) continue;
    const snippet = normalizeSnippet(result.snippet ?? result.content, snippetMaxChars);
    sources.push({
      url: result.url,
      ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
      ...(snippet === undefined ? {} : { snippet }),
      ...(isIsoDate(result.date) ? { publishedAt: result.date } : {}),
    });
  }
  return { sources, truncated: false };
}

/** True for an MCP failure that says the session is gone and must be re-initialized. */
function isSessionRejection(error) {
  if (error?.status === 404) return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return error?.status === 400 && /session/i.test(message);
}

export class TinyFishSearchProvider {
  id = TINYFISH_ID;

  /** @type {string | undefined} cached `Mcp-Session-Id` for keyed requests */
  session;

  /** Monotonic JSON-RPC request id. */
  #nextId = 1;

  constructor(options) {
    this.options = options;
  }

  available() {
    const { keyState, endpoint } = this.options;
    return (
      this.options.enabled !== false &&
      URL.canParse(endpoint) &&
      (this.options.keyless === true || keyState.available())
    );
  }

  async search(request, signal) {
    const { keyState, keyless, timeoutMs, snippetMaxChars } = this.options;
    const apiKey = await keyState.resolve();
    if (apiKey === undefined && keyless !== true) {
      throw new WebError(
        'TinyFish search requires an API key (apiKey or TINYFISH_API_KEY) when keyless fallback is disabled',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      );
    }
    const text = await this.#callSearch(this.#arguments(request), apiKey, signal, false);
    return mapToolText(text, snippetMaxChars);
  }

  /** Build the `search` tool arguments, omitting empty optional ones. */
  #arguments(request) {
    const { domainType, language, location } = this.options;
    return {
      query: request.query,
      ...(typeof domainType === 'string' && domainType.length > 0 ? { domain_type: domainType } : {}),
      ...(typeof language === 'string' && language.length > 0 ? { language } : {}),
      ...(typeof location === 'string' && location.length > 0 ? { location } : {}),
    };
  }

  async #callSearch(arguments_, apiKey, signal, retried) {
    const session = await this.#ensureSession(apiKey, signal, retried);
    try {
      const result = await this.#post(
        {
          jsonrpc: '2.0',
          id: this.#nextId++,
          method: 'tools/call',
          params: { name: 'search', arguments: arguments_ },
        },
        apiKey,
        session,
        signal,
      );
      if (result.result?.isError === true) {
        throw new WebError(
          `TinyFish search reported an error: ${toolText(result.result).slice(0, 500)}`,
          'WEB_PROVIDER_ERROR',
        );
      }
      return toolText(result.result);
    } catch (error) {
      // A stale keyed session is recoverable exactly once: drop it and re-initialize.
      if (retried === false && apiKey !== undefined && isSessionRejection(error)) {
        this.session = undefined;
        return this.#callSearch(arguments_, apiKey, signal, true);
      }
      throw error;
    }
  }

  /** Keyed requests need an `Mcp-Session-Id`; keyless requests are stateless. */
  async #ensureSession(apiKey, signal, force) {
    if (apiKey === undefined) return undefined;
    if (force !== true && this.session !== undefined) return this.session;
    const init = await this.#post(
      {
        jsonrpc: '2.0',
        id: this.#nextId++,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      },
      apiKey,
      undefined,
      signal,
    );
    this.session = init.sessionId;
    if (this.session !== undefined) {
      await this.#post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        apiKey,
        this.session,
        signal,
      );
    }
    return this.session;
  }

  async #post(payload, apiKey, sessionId, signal) {
    const { endpoint, timeoutMs } = this.options;
    const response = await httpRequest(
      'TinyFish',
      trimBaseUrl(endpoint),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'user-agent': USER_AGENT,
          ...(apiKey === undefined ? { 'x-tinyfish-access-mode': 'keyless' } : { 'x-api-key': apiKey }),
          ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        },
        body: JSON.stringify(payload),
      },
      signal,
      timeoutMs,
    );
    const message = parseRpcMessage(await response.text());
    if (message?.error !== undefined) {
      const detail = message.error?.message ?? JSON.stringify(message.error);
      const error = new WebError(`TinyFish ${payload.method} failed: ${detail}`, 'WEB_PROVIDER_ERROR');
      error.rpcCode = message.error?.code;
      throw error;
    }
    return { sessionId: response.headers.get('mcp-session-id') ?? undefined, result: message?.result };
  }
}
