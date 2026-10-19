#!/usr/bin/env node
/**
 * Undefined-name gate — the CI-enforceable slice of `tsc`.
 *
 * Why this exists instead of just failing on `tsc -p tsconfig.app.json`:
 * that config currently reports ~1.8k pre-existing errors, so a full gate can
 * only ever be red and would be switched off within a day. This one fails on
 * the single error class that is ALWAYS a runtime crash and never a matter of
 * type-modelling taste:
 *
 *   TS2304  Cannot find name 'x'
 *   TS2552  Cannot find name 'x'. Did you mean 'y'?
 *
 * A name TypeScript cannot resolve is a `ReferenceError` the moment that line
 * runs — types are erased, but a free variable is not. This is exactly how the
 * Lingui `t` crash reached production twice: `t(d.label)` with no `useLingui()`
 * binding, shipped green through eslint (no-undef is off for TS), through
 * `lingui extract` (the strings were declared correctly elsewhere), and through
 * a `tsc --noEmit` that was checking zero files.
 *
 * Run the full check with `npm run type-check` — that is the honest number and
 * the burn-down target. This script is the floor that must never regress.
 *
 * This replaces `scripts/check-lingui-macro-scope.py`, a regex scanner added by
 * the SAME PR (#296) that shipped the crash. It searched for `` t` `` and
 * `<Trans>` but not `t(...)`, so it reported "0 files with a macro used but not
 * in scope" on the very file it was written to protect — and it was never wired
 * into CI or pre-commit, so it never ran anyway. Don't reintroduce a regex
 * version: the compiler already resolves scope, aliases and re-exports
 * correctly, and a pattern that is one call-syntax short is worse than no check
 * because it reads as an all-clear.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths the gate is enforced on. `tests/` is deliberately excluded: it does not
 * ship, and `tests/react/agentic_process_stress.test.ts` still asserts against
 * `resolvedStatus` / `ProcessorStatus`, an API removed from the SDK. Fixing
 * that test means deciding what it should assert now — a separate change.
 * Drop this filter once that file is dealt with.
 */
const ENFORCED = [/^src\//, /^\.\.\/ts_sdk\/src\//];
const UNDEFINED_NAME = /error TS(2304|2552):/;

execFile(
  'node',
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.app.json', '--noEmit'],
  { cwd: uiRoot, maxBuffer: 64 * 1024 * 1024 },
  (_err, stdout) => {
    const lines = stdout.split('\n');
    const all = lines.filter((l) => / error TS/.test(l));
    const offenders = lines.filter((l) => UNDEFINED_NAME.test(l) && ENFORCED.some((re) => re.test(l)));

    if (offenders.length > 0) {
      console.error('\nUndefined names in shipping code — each one is a runtime ReferenceError:\n');
      for (const line of offenders) console.error('  ' + line.trim());
      console.error(
        `\n${offenders.length} undefined name(s). A missing import or a binding that was ` +
          'deleted out from under its call site.\n' +
          "If it is the Lingui `t`, add: import { useLingui } from '@lingui/react/macro'; " +
          'and `const { t } = useLingui();` inside the component.\n',
      );
      process.exit(1);
    }

    console.log(`No undefined names in shipping code (src/, ts_sdk/src/).`);
    console.log(`Full type-check debt, not gated here: ${all.length} errors — see 'npm run type-check'.`);
  },
);
