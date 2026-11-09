'use strict';

/*
 * Tests for ./update-test.js — the update-cycle harness hooks.
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/update-test.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { isEnabled, isScripted, answerFor, event, parseAnswers, forceRunAfter, checkBoundMs, checkIntervalMs, _setLogLine } = require('./update-test');

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Capture the lines update-test emits during fn. */
function capture(fn) {
  const lines = [];
  _setLogLine((line) => lines.push(line));
  try {
    fn();
  } finally {
    _setLogLine(null);
  }
  return lines;
}

// ── parseAnswers ─────────────────────────────────────────────────────────────
eq(parseAnswers('restart=later,engine=accept'), { restart: 'later', engine: 'accept' }, 'two answers');
eq(parseAnswers(' RESTART = Later '), { restart: 'later' }, 'trims + lowercases');
eq(parseAnswers(''), {}, 'empty');
eq(parseAnswers(undefined), {}, 'undefined');
eq(parseAnswers('noequals,=bad,ok=1'), { ok: '1' }, 'malformed entries skipped');

// ── disabled mode: inert ─────────────────────────────────────────────────────
withEnv({ FLOWPAD_UPDATE_TEST: undefined, FLOWPAD_UPDATE_TEST_ANSWERS: 'move=accept' }, () => {
  eq(isEnabled(), false, 'disabled without env');
  eq(answerFor('move'), null, 'answerFor → null when disabled');
  eq(isScripted('move'), false, 'isScripted → false when disabled');
  const lines = capture(() => {
    eq(answerFor('move'), null, 'no answer while disabled');
    event('boot', { desktop: '1.0.0' });
  });
  eq(lines, [], 'nothing logged while disabled');
});

// ── enabled mode: scripted answers ───────────────────────────────────────────
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_ANSWERS: 'move=accept,engine=upgrade,restart=later' }, () => {
  eq(isEnabled(), true, 'enabled with env');
  capture(() => {
    eq(answerFor('move'), 0, 'move=accept → button 0');
    eq(answerFor('engine'), 0, 'engine=upgrade → button 0');
    eq(answerFor('restart'), 1, 'restart=later → button 1');
    eq(answerFor('unknown-prompt'), 1, 'unscripted prompt → defer (button 1)');
  });
  eq([isScripted('restart'), isScripted('unknown-prompt')], [true, false], 'isScripted: only the prompts the answers name');
});

// ── enabled mode: log lines are single-line parseable JSON ───────────────────
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_ANSWERS: 'restart=later' }, () => {
  const lines = capture(() => {
    answerFor('restart', { version: '9.0.1' });
    event('backend-upgraded', { backend: '0.2.52' });
  });
  eq(lines.length, 2, 'two lines logged');
  for (const line of lines) {
    assert.ok(line.startsWith('[update-test] '), `prefix: ${line}`);
    passed++;
  }
  const prompt = JSON.parse(lines[0].slice('[update-test] '.length));
  eq(prompt, {
    event: 'prompt', prompt: 'restart', answer: 1, scripted: true, version: '9.0.1',
  }, 'prompt payload');
  const ev = JSON.parse(lines[1].slice('[update-test] '.length));
  eq(ev, { event: 'backend-upgraded', backend: '0.2.52' }, 'event payload');
});

// ── forceRunAfter: relaunch is skipped only in test mode ─────────────────────
withEnv({ FLOWPAD_UPDATE_TEST: undefined }, () => {
  eq(forceRunAfter(true), true, 'normal run: relaunch after the install is unchanged');
  eq(forceRunAfter(false), false, 'normal run: no relaunch stays no relaunch');
});
withEnv({ FLOWPAD_UPDATE_TEST: '1' }, () => {
  eq(forceRunAfter(true), false, 'test mode: the harness relaunches, the updater does not');
});

// ── checkBoundMs: only in test mode, only a positive number ──────────────────
withEnv({ FLOWPAD_UPDATE_TEST: undefined, FLOWPAD_UPDATE_TEST_CHECK_BOUND_MS: '90000' }, () => {
  eq(checkBoundMs(), undefined, 'normal run: the app keeps its own bound');
});
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_CHECK_BOUND_MS: '90000' }, () => {
  eq(checkBoundMs(), 90000, 'test mode: the bound from the environment');
});
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_CHECK_BOUND_MS: 'soon' }, () => {
  eq(checkBoundMs(), undefined, 'test mode, garbage value: the app default');
});
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_CHECK_BOUND_MS: undefined }, () => {
  eq(checkBoundMs(), undefined, 'test mode, unset: the app default');
});

// ── checkIntervalMs: same rules as the bound ─────────────────────────────────
withEnv({ FLOWPAD_UPDATE_TEST: undefined, FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS: '30000' }, () => {
  eq(checkIntervalMs(), undefined, 'normal run: the app keeps its own periodic interval');
});
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS: '30000' }, () => {
  eq(checkIntervalMs(), 30000, 'test mode: the interval from the environment');
});
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS: '0' }, () => {
  eq(checkIntervalMs(), undefined, 'test mode, zero: the app default');
});

console.log(`update-test.test.js: ${passed} assertions passed`);
