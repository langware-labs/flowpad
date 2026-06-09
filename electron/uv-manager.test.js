'use strict';

/*
 * Tests for ./uv-manager.js pure helpers + the broken-install detector.
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/uv-manager.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const UvManager = require('./uv-manager');
const { needsShellOnWin, quoteWinCmd, parseNetstatPids } = UvManager;

const IS_WIN = process.platform === 'win32';

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// ── needsShellOnWin ─────────────────────────────────────────────────────────
// The Windows-only branches can only be meaningfully exercised on Windows
// (IS_WIN is captured at module load); on other platforms it must always be
// false so spawn() goes through the native path.
if (IS_WIN) {
  eq(needsShellOnWin('uv'), true, 'bare name → needs shell (PATH lookup)');
  eq(needsShellOnWin('flow.cmd'), true, 'bare .cmd → needs shell');
  eq(needsShellOnWin('C:\\Users\\joe\\.local\\bin\\flow.exe'), true,
    '.exe path without spaces → cmd.exe is fine');
  eq(needsShellOnWin('C:\\Users\\avi tal\\.local\\bin\\flow.exe'), false,
    '.exe path WITH spaces → bypass cmd.exe (it would split on the space)');
  eq(needsShellOnWin('C:\\Users\\avi tal\\.local\\bin\\flow.cmd'), true,
    '.cmd path with spaces still needs the shell (gets quoted)');
} else {
  eq(needsShellOnWin('uv'), false, 'non-Windows → never shell');
  eq(needsShellOnWin('/Users/avi tal/.local/bin/flow'), false, 'non-Windows → never shell (2)');
}

// ── quoteWinCmd ─────────────────────────────────────────────────────────────
eq(quoteWinCmd('uv'), 'uv', 'no whitespace → unchanged');
eq(quoteWinCmd('C:\\bin\\flow.exe'), 'C:\\bin\\flow.exe', 'no whitespace path → unchanged');
eq(quoteWinCmd('C:\\avi tal\\flow.cmd'), '"C:\\avi tal\\flow.cmd"', 'whitespace → quoted');

// ── parseNetstatPids ────────────────────────────────────────────────────────
const netstat = [
  '  TCP    127.0.0.1:9007     0.0.0.0:0         LISTENING       1234',
  '  TCP    0.0.0.0:90071      0.0.0.0:0         LISTENING       5678', // must NOT match 9007
  '  TCP    127.0.0.1:9007     127.0.0.1:55001   ESTABLISHED     9999', // not LISTENING → ignore
  '  TCP    [::]:9007          [::]:0            LISTENING       1234', // ipv6, dup pid
  '  UDP    0.0.0.0:9007       *:*                               4321', // UDP → ignore
].join('\r\n');

eq(parseNetstatPids(netstat, 9007), [1234],
  'only LISTENING TCP rows on the exact local port 9007 (dedup, no :90071, no ESTABLISHED, no UDP)');
eq(parseNetstatPids(netstat, 90071), [5678], 'exact match for 90071 (not greedily matched by 9007)');
eq(parseNetstatPids('', 9007), [], 'empty netstat output → no pids');
eq(parseNetstatPids('garbage\nProto Local Foreign State PID', 9007), [], 'header/garbage → no pids');

// ── isBrokenInstallError (the self-heal trigger) ────────────────────────────
const silentLog = { info() {}, warn() {}, error() {} };
const mgr = new UvManager(silentLog);

ok(mgr.isBrokenInstallError({
  message: "flow start exited with code 1\nstderr:\nModuleNotFoundError: No module named 'flow_sdk'",
}), 'ModuleNotFoundError for flow_sdk in message → broken install');
ok(mgr.isBrokenInstallError({ stderr: "ModuleNotFoundError: No module named 'flow_sdk'" }),
  'same signal carried on error.stderr → broken install');
ok(mgr.isBrokenInstallError({
  message: 'Traceback...\n  File ".../flow_sdk/__init__.py", line 3\nImportError: cannot import name X',
}), 'ImportError whose traceback runs through flow_sdk → broken install');
ok(!mgr.isBrokenInstallError({ message: 'ConnectionRefused: backend port 9007 busy' }),
  'unrelated runtime error → NOT a broken install (no reinstall loop)');
ok(!mgr.isBrokenInstallError({ message: "ModuleNotFoundError: No module named 'requests'" }),
  'a missing module unrelated to flow_sdk (no flow_sdk in text) → NOT treated as broken install');
ok(!mgr.isBrokenInstallError({}), 'empty error object → not broken');
ok(!mgr.isBrokenInstallError(null), 'null error → not broken (no throw)');

console.log(`uv-manager.test.js: ${passed} assertions passed`);
