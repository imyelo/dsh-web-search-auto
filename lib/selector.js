/**
 * The composite `WebSearchProvider` registered as `ctx.web` search provider
 * `auto`. It owns a list of backend adapters and implements the two behaviours
 * the dsh seam deliberately leaves to a provider:
 *
 * - **selection** — which backend serves this call (`random`, `priority`,
 *   `round-robin`); `random` is opencode's "reuse one randomly chosen provider
 *   until it is rate limited, then switch" semantics, made sticky here.
 * - **failover** — a failing backend is cooled down and the next candidate is
 *   tried within the same call; caller cancellation aborts immediately.
 *
 * @module dsh-web-search-auto/selector
 */
import { WebError } from '@deepseek-ai/dsh-web';

/** Strategies accepted by the selector (the schema validates these too). */
const STRATEGIES = new Set(['random', 'priority', 'round-robin']);

/** Uniform shuffle in place (Fisher–Yates). */
function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

/** True when an error is a throttling answer that deserves the long cooldown. */
function isRateLimited(error) {
  return error?.rateLimited === true || error?.status === 402 || error?.status === 429 || error?.status === 432;
}

/** One-sentence description of a failed attempt for the aggregate error. */
function describeAttempt(attempt) {
  return `${attempt.id}: ${attempt.message}`;
}

export class AutoSearchProvider {
  /** @type {string} */
  id;

  #children;
  #strategy;
  #order;
  #cooldownMs;
  #rateLimitCooldownMs;
  #logger;
  /** The sticky choice for the `random` strategy. */
  #currentId;
  /** backend id → epoch ms until which it is skipped. */
  #cooldowns = new Map();
  #roundRobinCursor = 0;

  /**
   * @param {object} options
   * @param {string} options.id provider id in the search registry
   * @param {Array<{id: string, available(): boolean, search: Function}>} options.children backend adapters
   * @param {string} options.strategy selection strategy
   * @param {string[]} options.order preferred backend ids
   * @param {number} options.cooldownMs failure cooldown
   * @param {number} options.rateLimitCooldownMs throttling cooldown
   * @param {{debug: Function, warn: Function}} [options.logger] optional logger
   */
  constructor(options) {
    this.id = options.id;
    this.#children = options.children;
    this.#strategy = STRATEGIES.has(options.strategy) ? options.strategy : 'random';
    this.#order = Array.isArray(options.order) ? options.order : [];
    this.#cooldownMs = options.cooldownMs;
    this.#rateLimitCooldownMs = options.rateLimitCooldownMs;
    this.#logger = options.logger ?? { debug: () => {}, warn: () => {} };
    // No sticky choice yet: the first `random` call draws one.
    this.#currentId = undefined;
  }

  /** Usable while any backend is usable; the seam reports the rest. */
  available() {
    return this.#children.some((child) => child.available());
  }

  async search(request, signal) {
    const candidates = this.#children.filter((child) => child.available());
    if (candidates.length === 0) {
      throw new WebError('no search backend is usable (check API keys)', 'WEB_PROVIDER_UNAVAILABLE');
    }
    const attempts = [];
    let lastError;
    for (const child of this.#attemptOrder(this.#eligible(candidates))) {
      if (signal?.aborted) throw new WebError('web search aborted', 'WEB_ABORTED');
      try {
        const result = await child.search(request, signal);
        this.#currentId = child.id;
        this.#cooldowns.delete(child.id);
        return result;
      } catch (error) {
        if (error?.code === 'WEB_ABORTED' || signal?.aborted) {
          throw error?.code === 'WEB_ABORTED' ? error : new WebError('web search aborted', 'WEB_ABORTED', { cause: error });
        }
        lastError = error;
        this.#coolDown(child, error);
        if (this.#currentId === child.id) this.#currentId = undefined;
        const attempt = { id: child.id, message: error?.message ?? String(error) };
        attempts.push(attempt);
        this.#logger.debug('search backend %s failed, failing over: %s', child.id, attempt.message);
      }
    }
    // A single backend keeps its own error code; a real cascade gets an aggregate.
    if (attempts.length <= 1) throw lastError;
    const summary = attempts.map(describeAttempt).join('; ');
    this.#logger.warn('every search backend failed: %s', summary);
    throw new WebError(`every search backend failed (${summary})`, 'WEB_PROVIDER_ERROR', { cause: lastError });
  }

  /** Candidates that are not cooling down; when all are, cooldowns yield. */
  #eligible(candidates) {
    const now = Date.now();
    const fresh = candidates.filter((child) => (this.#cooldowns.get(child.id) ?? 0) <= now);
    return fresh.length > 0 ? fresh : candidates;
  }

  #coolDown(child, error) {
    const duration = isRateLimited(error) ? this.#rateLimitCooldownMs : this.#cooldownMs;
    if (Number.isFinite(duration) && duration > 0) this.#cooldowns.set(child.id, Date.now() + duration);
  }

  /** Order the backends this call will try, first choice included. */
  #attemptOrder(eligible) {
    if (this.#strategy === 'priority') return this.#sortByOrder(eligible);
    if (this.#strategy === 'round-robin') {
      const sorted = this.#sortByOrder(eligible);
      const start = this.#roundRobinCursor % sorted.length;
      this.#roundRobinCursor += 1;
      return [...sorted.slice(start), ...sorted.slice(0, start)];
    }
    // random: keep the sticky pick while it is a candidate, otherwise draw.
    const sticky = eligible.find((child) => child.id === this.#currentId);
    const first = sticky ?? eligible[Math.floor(Math.random() * eligible.length)];
    return [first, ...shuffle(eligible.filter((child) => child !== first))];
  }

  #sortByOrder(children) {
    const rank = (child) => {
      const index = this.#order.indexOf(child.id);
      return index === -1 ? this.#order.length : index;
    };
    return [...children].sort((left, right) => rank(left) - rank(right));
  }
}
