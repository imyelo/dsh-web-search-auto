/**
 * Exa backend for the composite provider: REST `POST /search` with highlight
 * contents (`Authorization: Bearer <key>`). Exa has no keyless REST mode, so a
 * missing key makes this child unavailable rather than degraded.
 *
 * @module dsh-web-search-auto/providers/exa
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { isIsoDate, normalizeSnippet, readJson, request as httpRequest, trimBaseUrl } from '../http.js';

/** Stable backend id (also its suffix when `exposeProviders` is on). */
export const EXA_ID = 'exa';

const USER_AGENT = 'dsh-web-search-auto/1.0.0';

/** Map one Exa result to a portable source; entries without a URL are dropped. */
function mapResult(result, snippetMaxChars) {
  if (typeof result?.url !== 'string' || result.url.length === 0) return undefined;
  const highlight = Array.isArray(result.highlights)
    ? result.highlights.find((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const snippet = normalizeSnippet(highlight, snippetMaxChars);
  return {
    url: result.url,
    ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
    ...(snippet === undefined ? {} : { snippet }),
    ...(isIsoDate(result.publishedDate) ? { publishedAt: result.publishedDate } : {}),
  };
}

/** Map Exa's response envelope to the seam's normalized search result. */
function mapResponse(body, snippetMaxChars) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return {
    sources: results.map((result) => mapResult(result, snippetMaxChars)).filter((source) => source !== undefined),
    truncated: false,
  };
}

export class ExaSearchProvider {
  /** @type {import('@deepseek-ai/dsh-web').WebSearchProvider['id']} */
  id = EXA_ID;

  constructor(options) {
    this.options = options;
  }

  available() {
    const { keyState, baseURL, numResults, highlightsPerResult } = this.options;
    return (
      this.options.enabled !== false &&
      keyState.available() &&
      URL.canParse(baseURL) &&
      Number.isInteger(highlightsPerResult) &&
      highlightsPerResult > 0 &&
      (numResults === undefined || (Number.isInteger(numResults) && numResults > 0))
    );
  }

  async search(request, signal) {
    const { keyState, baseURL, searchType, highlightsPerResult, numResults, timeoutMs, snippetMaxChars } =
      this.options;
    const apiKey = await keyState.resolve();
    if (apiKey === undefined) {
      throw new WebError('Exa search requires an API key (apiKey or EXA_API_KEY)', 'WEB_PROVIDER_CREDENTIAL_MISSING');
    }
    const limit = request.maxResults ?? numResults;
    const response = await httpRequest(
      'Exa',
      `${trimBaseUrl(baseURL)}/search`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          type: searchType,
          contents: { highlights: { highlightsPerUrl: highlightsPerResult } },
          ...(limit === undefined ? {} : { numResults: limit }),
        }),
      },
      signal,
      timeoutMs,
    );
    return mapResponse(await readJson(response, 'Exa'), snippetMaxChars);
  }
}
