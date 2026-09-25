'use strict';

/*
 * Tests for ./backend-wait.js — the startup gate that keeps waiting while the
 * server log is still being written.
 *
 * The bug this guards: a fixed 120s health window misread a slow-but-healthy
 * first boot (a weak machine importing the Python backend) as "failed to
 * start" and showed the recovery panel while the backend was still coming up.
 * The gate now extends past the base window on evidence — new bytes in the
 * server log — and still ends on a real stall or a restart loop.
 *
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/backend-wait.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { waitForBackend, createLogActivityProbe, createChangeProbe } = require('./backend-wait');

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

const silentLog = { info() {}, warn() {}, error() {} };

// A gate with a fake clock: every "sleep" advances time by intervalMs.
function gate({ healthyAt = Infinity, activeChecks = () => false, abortedAt = () => null, maxChecks = 4, stallChecks = 3, hardCapChecks = 20, onExtended } = {}) {
  let clock = 0;
  let checks = 0;
  const notices = [];
  return waitForBackend({
    probeHealth: async () => ++checks >= healthyAt,
    logActivity: () => activeChecks(checks),
    aborted: () => abortedAt(checks),
    maxChecks,
    stallChecks,
    hardCapChecks,
    intervalMs: 500,
    noticeEveryChecks: 1,
    onExtended: onExtended || ((s) => notices.push(s)),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: silentLog,
  }).then((r) => ({ ...r, notices }));
}

async function main() {
  // ── healthy inside the base window: no extension, no notices ─────────────
  {
    const r = await gate({ healthyAt: 2 });
    eq([r.ready, r.reason, r.extended, r.checks, r.notices], [true, 'healthy', false, 2, []],
      'healthy on the 2nd poll → ready, never extended');
  }

  // ── base window over and the log already silent: the old behaviour ───────
  {
    const r = await gate();
    eq([r.ready, r.reason, r.extended, r.checks], [false, 'timeout', false, 4],
      'silent log → give up exactly at maxChecks, as before');
    eq(r.elapsedSec, 2, '4 checks × 500ms sleeps, minus the last sleep that never happens → 1.5s rounds to 2');
  }

  // ── the log keeps growing past the base window, then health arrives ──────
  {
    const r = await gate({ healthyAt: 9, activeChecks: () => true });
    eq([r.ready, r.reason, r.extended, r.checks], [true, 'healthy', true, 9],
      'active log carries the wait past maxChecks until the backend answers');
    eq(r.notices.length > 0, true, 'the user is told the wait is deliberate');
  }

  // ── the log goes quiet after extending: stall ends the wait ──────────────
  {
    // Activity on checks 1..6, nothing after. stallChecks=3 → give up on check 9
    // (three silent checks 7, 8, 9 after the last active one).
    const r = await gate({ activeChecks: (n) => n <= 6 });
    eq([r.ready, r.reason, r.extended, r.checks], [false, 'stalled', true, 9],
      'a log that stops growing ends the extension after stallChecks silent polls');
  }

  // ── a restart loop keeps the log alive forever: the hard cap ends it ─────
  {
    const r = await gate({ activeChecks: () => true, hardCapChecks: 12 });
    eq([r.ready, r.reason, r.extended, r.checks], [false, 'hard-cap', true, 12],
      'an always-active log cannot hold the gate past hardCapChecks');
  }

  // ── activity only counts if it is recent when the base window ends ───────
  {
    // Active on check 1 only; by check 4 it is 3 checks stale == stallChecks.
    const r = await gate({ activeChecks: (n) => n === 1 });
    eq([r.reason, r.extended, r.checks], ['timeout', false, 4],
      'stale activity does not extend the window');
  }

  // ── misconfiguration is refused, not silently clamped ────────────────────
  {
    let threw = false;
    try {
      await gate({ maxChecks: 5, hardCapChecks: 4 });
    } catch {
      threw = true;
    }
    eq(threw, true, 'hardCapChecks below maxChecks is a programming error');
  }

  // ── the log activity probe ───────────────────────────────────────────────
  {
    let newest = { path: '/logs/server/old.log' };
    const sizes = { '/logs/server/old.log': 100 };
    const probe = createLogActivityProbe({
      newestLogFile: () => newest,
      fileSize: (p) => { if (!(p in sizes)) throw new Error('ENOENT'); return sizes[p]; },
    });
    eq(probe(), false, 'a log left over from the previous launch is not activity');
    sizes['/logs/server/old.log'] = 150;
    eq(probe(), true, 'more bytes in the same file → active');
    eq(probe(), false, 'no change since last call → idle');
    newest = { path: '/logs/server/new.log' };
    sizes['/logs/server/new.log'] = 0;
    eq(probe(), true, 'a new newest file (monitor restarted the backend) → active, even while empty');
    eq(probe(), false, 'still empty → idle');
    sizes['/logs/server/new.log'] = 10;
    eq(probe(), true, 'the new file grows → active');
    delete sizes['/logs/server/new.log'];
    eq(probe(), false, 'a file that vanished mid-stat is idle, not a crash');
    newest = null;
    eq(probe(), false, 'no server log directory yet → idle');
  }

  // ── no server log at all: behaves exactly like the fixed window ──────────
  {
    const probe = createLogActivityProbe({ newestLogFile: () => null, fileSize: () => 0 });
    eq(probe(), false, 'nothing to watch → never active');
  }

  // ── the launcher exited non-zero: nothing to wait for, its reason wins ───
  {
    const r = await gate({ activeChecks: () => true, abortedAt: (n) => (n >= 2 ? 'launcher-failed' : null) });
    eq([r.ready, r.reason, r.extended, r.checks], [false, 'launcher-failed', false, 2],
      'an abort ends the gate at once, inside the base window and despite activity');
  }
  {
    const r = await gate({ healthyAt: 1, abortedAt: () => 'launcher-failed' });
    eq([r.ready, r.reason], [true, 'healthy'],
      'health is checked before the abort: a backend that answers is up, whatever the launcher said');
  }

  // ── activity that only starts after the base window is over cannot help ──
  {
    // Nothing moved for the whole base window (4 checks ≥ stallChecks 3): the
    // boot was dead before its log woke up. The reporter writes its first line
    // at t=0 precisely so a live boot never looks like this.
    const r = await gate({ activeChecks: (n) => n >= 5 });
    eq([r.reason, r.checks], ['timeout', 4], 'late activity does not resurrect a window already silent for stallChecks');
  }

  // ── the change probe: any counter becomes an activity signal ─────────────
  {
    let lines = 3;
    const probe = createChangeProbe(() => lines);
    eq(probe(), false, 'primed at construction: history is not activity');
    lines = 4;
    eq(probe(), true, 'a new line → active');
    eq(probe(), false, 'no new line → idle');
    lines = 6;
    eq(probe(), true, 'two lines since the last look → active once');
  }

  console.log(`backend-wait.test.js: ${passed} assertions passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
