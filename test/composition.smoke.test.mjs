/**
 * One installation smoke test, deliberately the only test that crosses into
 * DSH: it proves the bundle installs into a throwaway DSH_HOME, its patch row
 * composes, no bundle is skipped, and the compatibility gate accepts the
 * manifest. Loader merge semantics and runtime behavior are DSH's own tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshInstallNodeModules } from '../scripts/test-hooks.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const dshPackageJson = join(dshInstallNodeModules, '@deepseek-ai', 'dsh', 'package.json');

/** Run the dsh CLI against the throwaway home, never the user's. */
function runDsh(home, args) {
  const env = { ...process.env, DSH_HOME: home };
  delete env.DSH_PROFILE;
  delete env.DSH_PROFILE_DIR;
  return execFileSync('dsh', args, { encoding: 'utf8', env, stdio: 'pipe' });
}

test('Install smoke: the bundle installs into a temp DSH_HOME, the row mounts and the compatibility gate passes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-web-search-auto-'));
  try {
    runDsh(home, ['--profile', 'fixture', '--from-default-profile', 'headless', '--dump-config']);
    runDsh(home, ['plugin', '--profile', 'fixture', 'add', pluginDir]);

    const boot = await import('@deepseek-ai/dsh-app-boot');
    const profile = boot.loadProfile('dsh', 'fixture', dshPackageJson, home, { userLayer: false });
    const entries = boot.composeEntries([...profile.layers.map((layer) => layer.patches), profile.patches]);
    const row = entries.find((entry) => entry.id === 'web-search-auto');

    assert.equal(row?.name, '@local/web-search-auto');
    assert.deepEqual(row.config, {});
    assert.deepEqual(profile.skippedBundles, [], 'no bundle should be skipped');

    const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
    assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, 'peer declaration should pass the runtime compatibility gate');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
