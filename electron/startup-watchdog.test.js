'use strict';
// Tests for startup-watchdog.js: the phase journal, crash detection across launches, one start at a time.
const assert = require('assert');
const sw = require('./startup-watchdog');

let count = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); count++; };
const ok = (v, m) => { assert.ok(v, m); count++; };

function memFs() {
  const files = {};
  return {
    files,
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, t) => { files[p] = t; },
  };
}
const mk = (fsx, extra = {}) => sw.createStartupJournal({ readFile: fsx.readFile, writeFile: fsx.writeFile, filePath: '/j.json', appVersion: '0.2.52', pid: 1, now: () => 1000, ...extra });

// ── phases are persisted as they happen ─────────────────────────────────────
{
  const f = memFs();
  const j = mk(f);
  eq(j.previous(), null, 'first run: no previous record');
  ok(!j.previousRunCrashed() && j.consecutiveAbnormalRuns() === 0 && !j.recoveryMode(), 'first run is not a crash');
  j.mark('electron-initialized');
  j.mark('renderer-loaded');
  j.mark('backend-start', { attempt: 1 });
  const saved = JSON.parse(f.files['/j.json']);
  eq(saved.phase, 'backend-start', 'the current phase is on disk');
  eq(saved.history.map((h) => h.phase), ['electron-initialized', 'renderer-loaded', 'backend-start'], 'history in order');
  eq(saved.history[2].extra, { attempt: 1 }, 'extra carried');
  assert.throws(() => j.mark('nope'), /unknown startup phase/); count++;
}

// ── test 10: a previous run that died before a terminal phase is detected ───
{
  const f = memFs();
  const first = mk(f);
  first.mark('electron-initialized');
  first.mark('renderer-loaded');
  first.mark('backend-start'); // …and the main process died here
  const warned = [];
  const second = mk(f, { log: { warn: (m) => warned.push(m), info: () => {} } });
  ok(second.previousRunCrashed(), 'the next launch sees the abnormal ending');
  eq(second.consecutiveAbnormalRuns(), 1, 'one in a row');
  ok(!second.recoveryMode(), 'one crash does not force recovery mode');
  ok(warned.some((m) => /ended abnormally in phase "backend-start"/.test(m)), 'logged with the phase it died in');
  second.mark('electron-initialized'); // dies again
  const third = mk(f);
  eq(third.consecutiveAbnormalRuns(), 2, 'two in a row');
  ok(third.recoveryMode(), 'two abnormal endings → recovery mode');
  third.mark('electron-initialized');
  third.mark('backend-healthy');
  const fourth = mk(f);
  ok(!fourth.previousRunCrashed() && fourth.consecutiveAbnormalRuns() === 0, 'a run that reached a terminal phase resets the count');
}

// ── every terminal phase counts as a clean ending ───────────────────────────
for (const phase of ['backend-healthy', 'fatal-failure', 'startup-failed', 'recovery-update', 'recovery-failed', 'clean-exit']) {
  const f = memFs();
  const j = mk(f);
  j.mark('electron-initialized');
  j.mark(phase);
  ok(!mk(f).previousRunCrashed(), `${phase} is terminal`);
}

// ── unreadable journal: never a crash claim ─────────────────────────────────
{
  const f = memFs();
  f.files['/j.json'] = 'garbage';
  ok(!mk(f).previousRunCrashed(), 'garbage → no previous');
  const failing = sw.createStartupJournal({ readFile: () => { throw new Error('x'); }, writeFile: () => { throw new Error('disk full'); }, filePath: '/j', appVersion: '1', pid: 1, log: { warn: () => {}, info: () => {} } });
  failing.mark('electron-initialized'); count++; // a write failure must not throw into startup
}

// ── the separate recovery entry point ───────────────────────────────────────
{
  ok(sw.recoveryRequested(['Flowpad.exe', '--recovery']) && sw.recoveryRequested(['x', '--flowpad-recovery']), '--recovery flag');
  ok(!sw.recoveryRequested(['Flowpad.exe', 'flowpad://x']) && !sw.recoveryRequested(undefined), 'absent');
}

// ── one backend start at a time ─────────────────────────────────────────────
(async () => {
  const warned = [];
  const guard = sw.createStartGuard({ log: { warn: (m) => warned.push(m) } });
  let release;
  const first = guard.run('startup', () => new Promise((r) => { release = r; }));
  const second = await guard.run('retry', async () => 'ran');
  eq(second, { skipped: true, busy: 'startup' }, 'a second start while one is in flight is skipped');
  ok(warned.some((m) => /"retry" skipped/.test(m)), 'and logged');
  release('done');
  eq(await first, { skipped: false, result: 'done' }, 'the first completes');
  eq(await guard.run('retry', async () => 'ran'), { skipped: false, result: 'ran' }, 'free again afterwards');
  await guard.run('boom', async () => { throw new Error('x'); }).catch(() => {});
  eq(guard.busy, null, 'released after a failure too');
  console.log(`startup-watchdog.test.js: ${count} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
