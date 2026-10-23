# AGENTS.md

Notes for AI agents working in this repository.

## What this is

`dsh-web-search-auto` registers one composite `ctx.web` search provider that fans
out across Exa, Tavily and TinyFish. The web seam selects exactly one provider id
per call and has no cascade of its own, so the failover lives inside this plugin
(`lib/selector.js`).

## Layout

- `index.js` — plugin entry: reads config, builds backends, registers providers.
- `lib/config.js` — the loader-facing schema. Every field is optional because a
  profile override replaces the whole `config` mapping.
- `lib/selector.js` — strategy, cooldown and failover.
- `lib/keys.js` — per-backend key resolution and the cached `available()` flag.
- `lib/providers/` — one adapter per vendor. Add a vendor here, then wire it in
  `index.js` and `lib/config.js`.
- `cordis.patch.yml` — the bundle patch that inserts the `web-search-auto` row.

## Tests

- `npm test` runs `node --test test/*.test.mjs`. Node 22.15 or newer.
- The suite covers selection and failover, the three vendor adapters against a
  local mock server, config defaults and key precedence, and one install check
  into a temporary `DSH_HOME`.
- The suite does not retest the harness's own plugin loading or web service
  behavior. Those belong to dsh; keep the suite on the contracts this plugin
  owns (request shape, result mapping, selection, key resolution).
- No test reaches the network. Mock the vendor endpoints with
  `test/helpers.mjs`.

## Conventions

- No dependencies, no lockfile. Use the Node standard library.
- User-facing docs live in `README.md` and `README.zh.md`. Keep the two in
  sync; they are the same document.
- Commit messages follow Conventional Commits.
