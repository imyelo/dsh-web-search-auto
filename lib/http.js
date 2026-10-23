/**
 * Small HTTP helpers shared by the backend adapters: caller cancellation plus a
 * per-request timeout, {@link WebError} mapping, and snippet normalization.
 *
 * Bare `fetch()` is deliberate: the harness' own `dsh-web-fetch-http` provider
 * rejects DNS answers inside Surge's fake-IP range, while a plugin-local fetch
 * only has to reach the vendor API (see .scratch/HANDOFF.md §4).
 *
 * @module dsh-web-search-auto/http
 */
import { WebError } from '@deepseek-ai/dsh-web';

/** HTTP statuses that mean "this key/plan is throttled", not "this request was malformed". */
const RATE_LIMIT_STATUSES = new Set([402, 429, 432]);

/** True when a thrown value is a DOM abort. */
export function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Raise the canonical cancellation error. */
export function abortedError(cause) {
  return new WebError('web search aborted', 'WEB_ABORTED', cause === undefined ? undefined : { cause });
}

/** Attach the machine-relevant bits a failover decision needs to a WebError. */
function providerError(message, { status, cause } = {}) {
  const error = new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause });
  if (status !== undefined) {
    error.status = status;
    error.rateLimited = RATE_LIMIT_STATUSES.has(status);
  }
  return error;
}

/**
 * Combine the caller's signal with a timeout. The timeout abort is reported as
 * a provider failure; only the caller's abort maps to `WEB_ABORTED`.
 */
function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return { signal: timeout, timeout, cleanup: undefined };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([signal, timeout]), timeout, cleanup: undefined };
  }
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs);
  return {
    signal: controller.signal,
    timeout,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    },
  };
}

/** Read a failed response's body into a short, human-readable detail string. */
async function failureDetail(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    const detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail;
    if (typeof detail === 'string' && detail.length > 0) return detail.slice(0, 500);
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return trimmed.slice(0, 500);
}

/**
 * Fetch with timeout + cancellation, mapping transport and HTTP failures to
 * {@link WebError}.
 *
 * @param {object} options
 * @param {string} options.label backend name for error messages
 * @param {string} options.url absolute request URL
 * @param {RequestInit} options.init fetch options (a `signal` here is ignored)
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {number} options.timeoutMs per-request timeout
 * @returns {Promise<Response>} a 2xx response
 */
export async function request(label, url, init, signal, timeoutMs) {
  const { signal: combined, timeout, cleanup } = combineSignals(signal, timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { ...init, signal: combined, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw abortedError(error);
      if (timeout.aborted) {
        throw providerError(`${label} request timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw providerError(`${label} request failed: ${String(error)}`, { cause: error });
    }
    if (response.ok) return response;
    throw providerError(`${label} API error (HTTP ${response.status})${await detailSuffix(response)}`, {
      status: response.status,
    });
  } finally {
    cleanup?.();
  }
}

async function detailSuffix(response) {
  const detail = await failureDetail(response);
  return detail === undefined ? '' : `: ${detail}`;
}

/** Parse a successful response body as JSON, mapping malformed bodies to WebError. */
export async function readJson(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw providerError(`${label} returned an unprocessable response body`, { cause: error });
  }
}

/**
 * Collapse whitespace and cap a vendor snippet. Long vendor snippets (Tavily's
 * markdown chunks, Exa's highlights) otherwise dominate the tool result. The
 * ellipsis is part of the cap, so the returned string never exceeds `maxChars`.
 *
 * @param {unknown} value raw snippet text
 * @param {number} maxChars cap; 0 or a non-finite value disables it
 * @returns {string | undefined} normalized snippet, or undefined when blank
 */
export function normalizeSnippet(value, maxChars) {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || collapsed.length <= maxChars) return collapsed;
  const limit = Math.floor(maxChars);
  if (limit <= 0) return '';
  if (limit === 1) return '…';
  const available = limit - 1;
  const hardCut = collapsed.slice(0, available);
  const lastSpace = hardCut.lastIndexOf(' ');
  const body = lastSpace > available * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${body.trimEnd()}…`;
}

/** True for an ISO-8601 date/datetime string, which is what the seam accepts. */
export function isIsoDate(value) {
  if (typeof value !== 'string' || value.length < 10) return false;
  return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
}

/** Relative ages returned by some vendors, e.g. `6 hours ago`. */
const RELATIVE_AGE = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

/** Approximate widths for the relative units vendors use; months and years are calendar-ish. */
const RELATIVE_UNIT_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** True when a date string already carries a zone, so appending `UTC` would break it. */
const HAS_ZONE = /(?:Z|\b(?:GMT|UTC)\b|[+-]\d{2}:?\d{2})\s*$/i;

/**
 * Normalize a vendor publication date to the ISO-8601 shape the seam expects.
 *
 * Exa already returns ISO dates and Tavily returns RFC 2822 dates; both convert
 * exactly. TinyFish returns human dates (`Sep 8, 2026`) and relative ages
 * (`2 months ago`); the former is read as UTC midnight, while the latter is
 * approximated from `now` because the vendor does not supply an absolute date.
 *
 * @param {unknown} value raw vendor date
 * @param {number} [now] epoch ms used to resolve relative ages (tests pass a fixed clock)
 * @returns {string | undefined} an ISO-8601 date, or undefined when unparseable
 */
export function normalizePublishedAt(value, now = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (isIsoDate(text)) return text;
  const relative = RELATIVE_AGE.exec(text);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = RELATIVE_UNIT_MS[relative[2].toLowerCase()];
    const timestamp = now - amount * unit;
    // Date's valid range is ±8.64e15 ms; a vendor-supplied number could exceed it.
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return undefined;
    return new Date(timestamp).toISOString();
  }
  const parsed = new Date(HAS_ZONE.test(text) ? text : `${text} UTC`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Strip trailing slashes so `${baseURL}/search` never doubles a separator. */
export function trimBaseUrl(baseURL) {
  return typeof baseURL === 'string' ? baseURL.replace(/\/+$/, '') : '';
}
