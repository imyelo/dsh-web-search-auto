/**
 * Tavily backend for the composite provider: REST `POST /search`.
 *
 * Tavily accepts keyless requests (`X-Tavily-Access-Mode: keyless`) with lower
 * quotas, so a missing key degrades to keyless instead of disabling the child.
 *
 * @module dsh-web-search-auto/providers/tavily
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { isIsoDate, normalizeSnippet, readJson, request as httpRequest, trimBaseUrl } from '../http.js';

/** Stable backend id (also its suffix when `exposeProviders` is on). */
export const TAVILY_ID = 'tavily';

const USER_AGENT = 'dsh-web-search-auto/1.0.0';

/** Map one Tavily result to a portable source; entries without a URL are dropped. */
function mapResult(result, snippetMaxChars) {
  if (typeof result?.url !== 'string' || result.url.length === 0) return undefined;
  const snippet = normalizeSnippet(result.content, snippetMaxChars);
  const published = result.published_date ?? result.publishedDate;
  return {
    url: result.url,
    ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
    ...(snippet === undefined ? {} : { snippet }),
    ...(isIsoDate(published) ? { publishedAt: published } : {}),
  };
}

/** Map Tavily's response envelope to the seam's normalized search result. */
function mapResponse(body, snippetMaxChars) {
  const results = Array.isArray(body?.results) ? body.results : [];
  const answer = typeof body?.answer === 'string' && body.answer.trim().length > 0 ? body.answer.trim() : undefined;
  return {
    ...(answer === undefined ? {} : { content: answer }),
    sources: results.map((result) => mapResult(result, snippetMaxChars)).filter((source) => source !== undefined),
    truncated: false,
  };
}

export class TavilySearchProvider {
  id = TAVILY_ID;

  constructor(options) {
    this.options = options;
  }

  available() {
    const { keyState, baseURL } = this.options;
    return this.options.enabled !== false && URL.canParse(baseURL) && (this.options.keyless === true || keyState.available());
  }

  async search(request, signal) {
    const {
      keyState,
      baseURL,
      keyless,
      searchDepth,
      chunksPerSource,
      includeAnswer,
      timeoutMs,
      snippetMaxChars,
    } = this.options;
    const apiKey = await keyState.resolve();
    if (apiKey === undefined && keyless !== true) {
      throw new WebError(
        'Tavily search requires an API key (apiKey or TAVILY_API_KEY) when keyless fallback is disabled',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      );
    }
    const response = await httpRequest(
      'Tavily',
      `${trimBaseUrl(baseURL)}/search`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(apiKey === undefined
            ? { 'x-tavily-access-mode': 'keyless' }
            : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: searchDepth,
          chunks_per_source: chunksPerSource,
          ...(request.maxResults === undefined ? {} : { max_results: request.maxResults }),
          ...(includeAnswer === true ? { include_answer: true } : {}),
        }),
      },
      signal,
      timeoutMs,
    );
    return mapResponse(await readJson(response, 'Tavily'), snippetMaxChars);
  }
}
