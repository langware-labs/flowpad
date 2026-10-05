'use strict';

/*
 * Tests for ./electron-builder.config.cjs — the CI release-signing contract.
 *
 * The repo's electron-builder.json carries PLACEHOLDER Windows signing identity
 * (win.azureSignOptions: empty account/profile, publisherName "Your Company LTD");
 * the desktop release workflow patches the real values in. If that patch is
 * incomplete the build must FAIL, not ship: a placeholder publisherName is baked
 * into app-update.yml and makes electron-updater reject every Windows update.
 *
 * Each case loads the config in a fresh node process (its own env, its own module
 * cache) with electron-builder.json replaced through require.cache.
 * Run: `node electron/builder-config.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const JSON_PATH = require.resolve('./electron-builder.json');
const CONFIG_PATH = require.resolve('./electron-builder.config.cjs');
const committed = require('./electron-builder.json');

const REAL_IDENTITY = {
  endpoint: 'https://eus.codesigning.azure.net/',
  codeSigningAccountName: 'acct',
  certificateProfileName: 'profile',
  publisherName: 'Langware INC.',
};
const CREDS = { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };

/** Load the config with `azure` as win.azureSignOptions (null → the committed JSON as is). */
function load({ azure = null, env = {} } = {}) {
  const script = `
    const json = JSON.parse(${JSON.stringify(JSON.stringify(committed))});
    const azure = ${JSON.stringify(azure)};
    if (azure) json.win.azureSignOptions = azure;
    require.cache[${JSON.stringify(JSON_PATH)}] = { id: ${JSON.stringify(JSON_PATH)}, filename: ${JSON.stringify(JSON_PATH)}, loaded: true, exports: json };
    try {
      const cfg = require(${JSON.stringify(CONFIG_PATH)});
      console.log(JSON.stringify({ ok: true,
        azure: cfg.win.azureSignOptions || null,
        hooks: { afterPack: !!cfg.afterPack, afterSign: !!cfg.afterSign, artifactBuildCompleted: !!cfg.artifactBuildCompleted } }));
    } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }
  `;
  const cleanEnv = { PATH: process.env.PATH };
  const res = spawnSync(process.execPath, ['-e', script], { env: { ...cleanEnv, ...env }, encoding: 'utf8' });
  const line = (res.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
  assert.ok(line, `config load printed no result:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(line);
}

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };

// ── the committed JSON is what the CI patch step expects to find ────────────
{
  const azure = committed.win && committed.win.azureSignOptions;
  ok(azure, 'committed JSON keeps win.azureSignOptions (the CI patch target)');
  for (const k of ['endpoint', 'codeSigningAccountName', 'certificateProfileName', 'publisherName']) {
    ok(Object.prototype.hasOwnProperty.call(azure, k), `committed JSON keeps azureSignOptions.${k} for the CI patch step`);
  }
  ok(!azure.codeSigningAccountName && !azure.certificateProfileName,
    'committed JSON must not carry a real signing account/profile (they come from CI variables)');
}

// ── a release build (FLOWPAD_SIGNING=required) cannot ship unpatched or half-patched ─
{
  const r = load({ env: { FLOWPAD_SIGNING: 'required', ...CREDS } });
  eq(r.ok, false, 'required + the unpatched committed JSON → build fails');
  ok(/codeSigningAccountName/.test(r.error) && /certificateProfileName/.test(r.error) && /publisherName/.test(r.error),
    `unpatched failure names every missing identity key: ${r.error}`);
}
{
  const r = load({ azure: { ...REAL_IDENTITY, publisherName: 'Your Company LTD' }, env: { FLOWPAD_SIGNING: 'required', ...CREDS } });
  eq(r.ok, false, 'required + placeholder publisherName (account/profile patched) → build fails');
  ok(/publisherName/.test(r.error), `failure names publisherName: ${r.error}`);
}
{
  const r = load({ azure: { ...REAL_IDENTITY, publisherName: ['your company ltd'] }, env: { FLOWPAD_SIGNING: 'required', ...CREDS } });
  eq(r.ok, false, 'placeholder is detected case-insensitively and inside an array publisherName');
}
{
  const r = load({ azure: REAL_IDENTITY, env: { FLOWPAD_SIGNING: 'required' } });
  eq(r.ok, false, 'required + identity patched but no Azure credentials → build fails');
  ok(/AZURE_TENANT_ID/.test(r.error) && /AZURE_CLIENT_SECRET/.test(r.error), `failure names the missing credentials: ${r.error}`);
}
{
  const r = load({ azure: { ...REAL_IDENTITY, codeSigningAccountName: '' }, env: { FLOWPAD_SIGNING: 'required', ...CREDS } });
  eq(r.ok, false, 'required + an empty signing account name → build fails');
}

// ── a correctly patched release build keeps the identity and attaches the gates ─
{
  const r = load({ azure: REAL_IDENTITY, env: { FLOWPAD_SIGNING: 'required', ...CREDS } });
  eq(r.ok, true, 'required + full identity + credentials → config loads');
  eq(r.azure.publisherName, 'Langware INC.', 'the real publisherName is what app-update.yml will carry');
  eq(r.hooks, { afterPack: true, afterSign: true, artifactBuildCompleted: true },
    'signing gates (afterPack sign, afterSign verify, artifactBuildCompleted verify) are attached');
}

// ── a local build is allowed to be unsigned, loudly, and never half-signed ───
{
  const r = load({ env: {} });
  eq(r.ok, true, 'not required + nothing configured → unsigned local build loads');
  eq(r.azure, null, '…with azureSignOptions removed, so no placeholder identity is packaged');
  eq(r.hooks, { afterPack: false, afterSign: false, artifactBuildCompleted: false }, '…and no signing gates');
}
{
  const r = load({ azure: { ...REAL_IDENTITY, publisherName: 'Your Company LTD' }, env: CREDS });
  eq(r.azure, null, 'not required + placeholder publisherName → unsigned (never signs with a placeholder identity)');
}

// ── every local module the app requires is packaged ──────────────────────────
// `files` is an explicit allow-list: a new `require('./x')` that is not listed
// works in `npm run dev` and every unit test, and crashes only the packaged app
// at launch ("Cannot find module './x'").
{
  const fs = require('fs');
  const shipped = new Set(committed.files.filter((f) => !f.startsWith('!')));
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const [, rel] of src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      const resolved = path.relative(__dirname, require.resolve(path.join(__dirname, rel)));
      if (resolved.endsWith('.json')) continue; // package.json is packaged by electron-builder itself
      eq(shipped.has(resolved), true, `${file} requires ${rel} → "${resolved}" must be in electron-builder.json "files"`);
      walk(resolved);
    }
  };
  ['main.js', 'preload.js', 'loading-renderer.js'].forEach(walk);
}

console.log(`${path.basename(__filename)}: ${passed} assertions passed`);
