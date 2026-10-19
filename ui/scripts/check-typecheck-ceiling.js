#!/usr/bin/env node
/**
 * Typecheck ratchet — a ceiling on the total `tsc` error count.
 *
 * The full check on `tsconfig.app.json` cannot be gated at zero yet: a long
 * tail of pre-existing errors survives in `src/components`. A per-directory
 * allowlist does not work either, because no directory is at zero, so the
 * allowlist would start empty and gate nothing.
 *
 * So gate the NUMBER. The ceiling below is checked in; CI fails when the count
 * rises above it. That cannot regress silently — the only way to add a type
 * error is to also raise this number in the same commit, in review, on purpose.
 *
 * When you clear errors, LOWER the ceiling in the same commit. The script tells
 * you when it is stale so the number tracks reality instead of drifting into
 * meaninglessness.
 *
 * Companion to check-undefined-names.js, which is the zero-tolerance floor for
 * the one error class that is always a runtime crash. This one is the trend.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ceilingPath = join(here, 'typecheck-ceiling.json');
const { maxErrors } = JSON.parse(readFileSync(ceilingPath, 'utf8'));

let out = '';
try {
  out = execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.app.json'], {
    cwd: join(here, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  // tsc exits non-zero whenever there are errors; the output is what we want.
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

const errors = out.split('\n').filter((l) => / error TS\d+/.test(l));
const count = errors.length;

if (count > maxErrors) {
  const byFile = new Map();
  for (const line of errors) {
    const file = line.split('(')[0];
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  const worst = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.error(`\nTypecheck ceiling exceeded: ${count} errors, ceiling is ${maxErrors}.\n`);
  console.error('Most-affected files:\n');
  for (const [file, n] of worst) console.error(`  ${String(n).padStart(4)}  ${file}`);
  console.error(
    '\nFix the new errors, or — if the increase is deliberate and understood —\n' +
      `raise "maxErrors" in ${ceilingPath} in the same commit and say why.\n`,
  );
  process.exit(1);
}

if (count < maxErrors) {
  console.log(
    `Typecheck: ${count} errors, ceiling ${maxErrors} — ${maxErrors - count} below.\n` +
      `Lower "maxErrors" to ${count} in ${ceilingPath} so the ratchet keeps its grip.`,
  );
} else {
  console.log(`Typecheck: ${count} errors, exactly at the ceiling.`);
}
