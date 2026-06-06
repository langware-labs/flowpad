#!/usr/bin/env node
/**
 * Repro: @xterm/headless declares a "module" entry that is not in the
 * published package — bundlers that prefer "module" (Vite/Rollup/webpack)
 * fail to resolve the package entirely, while Node (using "main") works.
 *
 * Setup:   npm i @xterm/headless
 * Run:     node xterm-headless-module-entry-repro.mjs
 * Exit:    0 = package entries all resolve, 1 = "module" points at a
 *          missing file.
 *
 * Observed on @xterm/headless 6.0.0:
 *   main:   lib-headless/xterm-headless.js     (exists)
 *   module: lib/xterm.mjs                      (MISSING — actual ESM build
 *            is at lib-headless/xterm-headless.mjs)
 * Vite error: "Failed to resolve entry for package '@xterm/headless'.
 * The package may have incorrect main/module/exports specified in its
 * package.json."
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve('@xterm/headless/package.json');
const pkgDir = dirname(pkgJsonPath);
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

console.log(`@xterm/headless ${pkg.version}`);
let failures = 0;
for (const field of ['main', 'module', 'types']) {
  const rel = pkg[field];
  if (!rel) {
    console.log(`SKIP  ${field}: not declared`);
    continue;
  }
  const ok = existsSync(join(pkgDir, rel));
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${field}: ${rel}${ok ? '' : '   <-- file not in package'}`);
}

if (failures) {
  console.log(
    '\nBundlers preferring "module" cannot resolve this package.' +
      '\nShipped ESM build is at: lib-headless/xterm-headless.mjs',
  );
}
process.exit(failures ? 1 : 0);
