'use strict';

/*
 * Tests for ./renderer-watchdog.js — silence while on screen, confirmed by a failed probe, is a hang.
 * Run: `node electron/renderer-watchdog.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { createRendererWatchdog } = require('./renderer-watchdog');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

function make({ probeAnswers = false, screen = () => true } = {}) {
  let clock = 0;
  const hangs = [];
  const probes = [];
  const wd = createRendererWatchdog({
    onScreen: screen,
    probe: async (ms) => { probes.push(ms); return probeAnswers; },
    onHang: (i) => hangs.push(i),
    silenceMs: 10, probeMs: 3, now: () => clock,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  return { wd, hangs, probes, advance: (ms) => { clock += ms; } };
}

(async () => {
  {
    const { wd, hangs, advance } = make();
    wd.arm();
    for (let i = 0; i < 5; i++) { advance(4); wd.beat(); await wd._tick(); }
    eq(hangs.length, 0, 'beating renderer is never hung');
  }
  {
    const { wd, hangs, probes, advance } = make();
    wd.arm();
    advance(11); await wd._tick();
    eq(probes, [3], 'silence past the threshold is probed');
    eq(hangs.map((h) => h.source), ['heartbeat'], 'a failed probe confirms the hang');
    advance(11); await wd._tick();
    eq(hangs.length, 1, 'fires once per arming');
    wd.arm(); advance(11); await wd._tick();
    eq(hangs.length, 2, 're-armed after recovery, it watches again');
  }
  {
    const { wd, hangs, advance } = make({ probeAnswers: true });
    wd.arm();
    advance(11); await wd._tick();
    eq(hangs.length, 0, 'a probe that answers is throttling, not a hang');
  }
  {
    let visible = false;
    const { wd, hangs, probes, advance } = make({ screen: () => visible });
    wd.arm();
    advance(60); await wd._tick();
    eq([hangs.length, probes.length], [0, 0], 'off screen, silence is not counted');
    visible = true; advance(5); await wd._tick();
    eq(hangs.length, 0, 'the clock restarts when the window is back on screen');
  }
  {
    const { wd, hangs } = make();
    wd.hang('unresponsive');
    eq(hangs.length, 0, 'not armed: an outside signal is ignored');
    wd.arm(); wd.hang('unresponsive');
    eq(hangs.map((h) => h.source), ['unresponsive'], 'Chromium unresponsive counts once armed');
    wd.disarm(); wd.hang('unresponsive');
    eq(hangs.length, 1, 'disarmed during recovery');
  }
  console.log(`renderer-watchdog: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
