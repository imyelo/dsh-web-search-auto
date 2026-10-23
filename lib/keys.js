/**
 * API-key resolution for one backend.
 *
 * `WebSearchProvider.available()` must answer locally and synchronously, while
 * the credential store is asynchronous — so this class keeps a cached presence
 * flag for the fast path and resolves the actual value per operation (which is
 * also what makes a rotated key reach the next search without a restart).
 *
 * Resolution order mirrors the dsh convention: literal config value → credential
 * reference (managed store / process environment / .env layers) → launch
 * environment snapshot.
 *
 * @module dsh-web-search-auto/keys
 */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';

/** Trim a candidate secret; blank and non-strings read as "not set". */
function normalizeSecret(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Resolve one variable through the launch-time environment snapshot, if any. */
export function launchValue(ctx, name) {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  try {
    return normalizeSecret(launchEnvironmentOf(ctx).get(name)?.value);
  } catch {
    return undefined;
  }
}

/** Per-backend credential state shared by one provider instance. */
export class KeyState {
  #ctx;
  #literal;
  #envName;
  #keyless;
  /** undefined = not probed yet, true/false = last local resolution result. */
  #present;

  /**
   * @param {object} ctx plugin context
   * @param {{ apiKey?: string, apiKeyEnv?: string, keyless?: boolean }} options
   */
  constructor(ctx, options) {
    this.#ctx = ctx;
    this.#literal = normalizeSecret(options.apiKey);
    this.#envName = normalizeSecret(options.apiKeyEnv);
    this.#keyless = options.keyless === true;
    this.#present = this.#literal !== undefined || launchValue(ctx, this.#envName) !== undefined ? true : undefined;
    // Probe the async layers once in the background so `available()` can turn
    // false for a backend whose key exists nowhere. Never blocks activation.
    void this.#warm();
    this.#watchCredentials();
  }

  /** True while this backend could run: keyless always, keyed until proven absent. */
  available() {
    return this.#keyless || this.#present !== false;
  }

  /**
   * Resolve the key for one operation, refreshing the cached presence.
   * @returns {Promise<string | undefined>} the key, or undefined when unset.
   */
  async resolve() {
    if (this.#literal !== undefined) return this.#literal;
    const value = await this.#resolveRemote();
    this.#present = value !== undefined;
    return value;
  }

  async #resolveRemote() {
    const name = this.#envName;
    if (name === undefined) return launchValue(this.#ctx, name);
    const credentials = this.#ctx.get?.('credentials');
    if (credentials !== undefined && credentials !== null && isCredentialRefName(name)) {
      try {
        const resolved = await credentials.resolve(credentialRef(name));
        const value = normalizeSecret(resolved?.value);
        if (value !== undefined) return value;
      } catch {
        // A missing credential service is not a failure: fall through to the launch layer.
      }
    }
    return launchValue(this.#ctx, name);
  }

  async #warm() {
    if (this.#literal !== undefined) return;
    try {
      this.#present = (await this.#resolveRemote()) !== undefined;
    } catch {
      // Leave the optimistic "unknown" state in place.
    }
  }

  /**
   * Re-probe when the credential store reports a change for this reference.
   *
   * The selector filters unavailable children before calling `search()`, so a
   * backend that was marked absent would otherwise never resolve its key again:
   * storing a key later could not revive it without a reload. The event is
   * optional, so a context without the seam still works through the warm probe.
   */
  #watchCredentials() {
    const subscribe = this.#ctx.on;
    if (typeof subscribe !== 'function') return;
    try {
      subscribe.call(this.#ctx, 'credentials/reference-updated', (ref) => {
        if (this.#envName === undefined || String(ref) !== this.#envName) return;
        this.#present = undefined;
        void this.#warm();
      });
    } catch {
      // The event seam is not available in this context; keep the warm result.
    }
  }
}
