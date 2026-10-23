/**
 * Test-time module routing for this plugin repository.
 *
 * The plugin is a linked root: its bare `@deepseek-ai/*` imports resolve from
 * the DSH installation at runtime, never from this repo (there is no
 * node_modules and no dependency install). Node's default resolver does not
 * know that, so this hook maps every bare `@deepseek-ai/*` specifier to the
 * installed copy.
 *
 * Import this module before dynamically importing plugin code:
 *
 *   import '../scripts/test-hooks.mjs';
 *   const { AutoSearchProvider } = await import('../lib/selector.js');
 *
 * The installation is discovered from the `dsh` executable on PATH (following
 * the symlink into `.../node_modules/@deepseek-ai/dsh/lib/bin.js`), or from
 * `DSH_BIN`, or from `DSH_INSTALL_NODE_MODULES` when set.
 */
import { createRequire, registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function findDshInstallNodeModules() {
  if (process.env.DSH_INSTALL_NODE_MODULES) return process.env.DSH_INSTALL_NODE_MODULES;
  const bin = (
    process.env.DSH_BIN ?? execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  ).trim();
  if (bin === '') throw new Error('test-hooks: cannot find dsh; put it on PATH or set DSH_BIN');
  const real = realpathSync(bin);
  const marker = `${sep}node_modules${sep}`;
  const at = real.lastIndexOf(marker);
  if (at < 0) throw new Error(`test-hooks: ${real} is not inside a node_modules installation; set DSH_INSTALL_NODE_MODULES`);
  return real.slice(0, at + marker.length - 1);
}

/** `<install>/node_modules`, the root that holds every `@deepseek-ai/*` package. */
export const dshInstallNodeModules = findDshInstallNodeModules();

const dshRequire = createRequire(join(dshInstallNodeModules, '__test-anchor__.cjs'));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      try {
        return { url: pathToFileURL(dshRequire.resolve(specifier)).href, shortCircuit: true };
      } catch {
        // Fall back to the native resolver for anything the installation lacks.
      }
    }
    return nextResolve(specifier, context);
  },
});
