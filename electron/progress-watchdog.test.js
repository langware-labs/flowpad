'use strict';

/*
 * Tests for ./progress-watchdog.js — 30 s windows, 3 quiet windows in a row = stalled, any change resets.
 * Run: `node electron/progress-watchdog.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { createProgressWatchdog, DEFAULT_WINDOW_MS, DEFAULT_STRIKES } = require('./progress-watchdog');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

// Deterministic clock: advance(ms) runs every interval that falls due, in order.
function fakeTimers() {
  let now = 0;
  const jobs = [];
  return {
    setInterval(fn, ms) { const j = { fn, ms, next: now + ms, dead: false, unref() {} }; jobs.push(j); return j; },
    clearInterval(j) { if (j) j.dead = true; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = jobs.filter((j) => !j.dead && j.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next; due.next += due.ms; due.fn();
      }
      now = end;
    },
    live: () => jobs.filter((j) => !j.dead).length,
  };
}

const S = 1000;
function make(sampleFn, opts = {}) {
  const timers = fakeTimers();
  const stalls = [];
  const wd = createProgressWatchdog({ sample: sampleFn, onStall: (i) => stalls.push(i), timers, ...opts }).start();
  return { timers, stalls, wd };
}

eq([DEFAULT_WINDOW_MS, DEFAULT_STRIKES], [30000, 3], 'defaults are the approved 30 s x 3');

// No change at all: stalled after exactly 3 windows (90 s), not before.
{
  const { timers, stalls } = make(() => 0);
  timers.advance(30 * S); eq(stalls.length, 0, 'not stalled after 1 quiet window (30 s)');
  timers.advance(30 * S); eq(stalls.length, 0, 'not stalled after 2 quiet windows (60 s)');
  timers.advance(29 * S); eq(stalls.length, 0, 'not stalled at 89 s');
  timers.advance(1 * S);  eq(stalls.length, 1, 'stalled at 90 s: 3 quiet windows in a row');
  eq(stalls[0], { misses: 3, windowMs: 30000, strikes: 3 }, 'onStall says how it decided');
  timers.advance(600 * S); eq(stalls.length, 1, 'fires once, then the watchdog is done');
  eq(timers.live(), 0, 'and its timer is cleared');
}

// A change in any window resets the count to three fresh windows.
{
  let v = 0;
  const { timers, stalls, wd } = make(() => v);
  timers.advance(30 * S);              // miss 1
  timers.advance(30 * S);              // miss 2
  eq(wd.misses, 2, 'two quiet windows so far');
  v = 1;                               // a new byte arrives during the 3rd window
  timers.advance(30 * S);              // tick sees the change -> reset
  eq([wd.misses, stalls.length], [0, 0], 'a new byte in the 3rd window resets the count instead of stalling');
  timers.advance(30 * S); timers.advance(30 * S);
  eq([wd.misses, stalls.length], [2, 0], 'and it needs three fresh quiet windows again');
  timers.advance(30 * S);
  eq(stalls.length, 1, 'three fresh quiet windows after the reset -> stalled');
}

// Progress in every window: never stalls, however long it runs.
{
  let v = 0;
  const { timers, stalls } = make(() => v);
  for (let i = 0; i < 400; i++) { v += 1; timers.advance(30 * S); }
  eq(stalls.length, 0, 'a slow but steadily moving download is never interrupted (400 windows = 3+ hours)');
}

// A decrease is a change too (files removed / replaced is still activity).
{
  let v = 100;
  const { timers, stalls } = make(() => v);
  timers.advance(30 * S); timers.advance(30 * S);
  v = 40; timers.advance(30 * S);
  eq(stalls.length, 0, 'any change counts, not only growth');
}

// stop() disarms it.
{
  const { timers, stalls, wd } = make(() => 0);
  timers.advance(60 * S);
  wd.stop();
  timers.advance(600 * S);
  eq([stalls.length, timers.live()], [0, 0], 'stopped before the 3rd miss: never fires, timer cleared');
}

// A failing sampler never counts as a stall (our bug must not kill a good install).
{
  const warnings = [];
  const { timers, stalls } = make(() => { throw new Error('EACCES'); }, { log: { warn: (l) => warnings.push(l), info() {} } });
  timers.advance(600 * S);
  eq(stalls.length, 0, 'a throwing sampler is treated as "unknown", never as no-progress');
  eq(warnings.length > 0, true, 'and it is logged');
}

// Custom windows (tests / future callers).
{
  const { timers, stalls } = make(() => 0, { windowMs: 10, strikes: 2 });
  timers.advance(19); eq(stalls.length, 0, 'custom: 2 strikes of 10 ms, not yet at 19 ms');
  timers.advance(1); eq(stalls.length, 1, 'custom: stalled at 20 ms');
}

// ── async samplers, canStall gating, overlap (uv tool install scans directories asynchronously) ──
(async () => {
  const tick = () => new Promise((r) => setImmediate(r));

  // An async sampler works exactly like a sync one.
  {
    let v = 0;
    const { timers, stalls } = make(async () => v);
    await tick();
    for (let i = 0; i < 2; i++) { timers.advance(30 * S); await tick(); }
    eq(stalls.length, 0, 'async sampler: 2 quiet windows are not a stall');
    timers.advance(30 * S); await tick();
    eq(stalls.length, 1, 'async sampler: 3 quiet windows -> stalled');
  }
  {
    let v = 0;
    const { timers, stalls, wd } = make(async () => v);
    await tick();
    timers.advance(30 * S); await tick(); timers.advance(30 * S); await tick();
    v = 5; timers.advance(30 * S); await tick();
    eq([wd.misses, stalls.length], [0, 0], 'async sampler: a change resets the count');
  }

  // A slow scan still running when the next tick is due: that tick is skipped, not counted as a miss.
  {
    let release; let calls = 0; let first = true;
    const { timers, stalls, wd } = make(() => { calls++; if (first) { first = false; return Promise.resolve(0); } return new Promise((r) => { release = () => r(0); }); });
    await tick(); // the baseline scan finishes
    calls = 0;
    timers.advance(30 * S);                 // tick 1 starts a scan that does not finish
    timers.advance(30 * S); timers.advance(30 * S); timers.advance(30 * S);
    eq(calls, 1, 'overlapping ticks do not start a second scan');
    eq([stalls.length, wd.misses], [0, 0], 'and they are not counted as quiet windows');
    release(); await tick();
  }

  // canStall = false: silence is not counted at all (the signal is not trusted yet).
  {
    let trusted = false;
    const { timers, stalls, wd } = make(() => 0, { canStall: () => trusted });
    for (let i = 0; i < 10; i++) timers.advance(30 * S);
    eq([stalls.length, wd.misses], [0, 0], 'canStall=false: 300 s of silence never stalls and never accumulates');
    trusted = true;
    timers.advance(30 * S); timers.advance(30 * S);
    eq(stalls.length, 0, 'canStall=true: counting starts fresh (2 windows: not yet)');
    timers.advance(30 * S);
    eq(stalls.length, 1, 'canStall=true: 3 quiet windows since trust -> stalled');
  }

  // A rejecting async sampler is treated as progress, never as a stall.
  {
    const { timers, stalls } = make(async () => { throw new Error('EMFILE'); });
    for (let i = 0; i < 8; i++) { timers.advance(30 * S); await tick(); }
    eq(stalls.length, 0, 'a rejecting async sampler never stalls');
  }

  console.log(`progress-watchdog.test.js: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
