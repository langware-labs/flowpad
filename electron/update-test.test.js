'use strict';

/*
 * Tests for ./update-test.js — the update-cycle harness hooks.
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/update-test.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { isEnabled, answerFor, event, parseAnswers, _setLogLine } = require('./update-test');

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
eq(parseAnswers('dual=later,backend=accept'), { dual: 'later', backend: 'accept' }, 'two answers');
eq(parseAnswers(' DUAL = Later '), { dual: 'later' }, 'trims + lowercases');
eq(parseAnswers(''), {}, 'empty');
eq(parseAnswers(undefined), {}, 'undefined');
eq(parseAnswers('noequals,=bad,ok=1'), { ok: '1' }, 'malformed entries skipped');

// ── disabled mode: inert ─────────────────────────────────────────────────────
withEnv({ FLOWPAD_UPDATE_TEST: undefined, FLOWPAD_UPDATE_TEST_ANSWERS: 'dual=accept' }, () => {
  eq(isEnabled(), false, 'disabled without env');
  eq(answerFor('dual'), null, 'answerFor → null when disabled');
  const lines = capture(() => {
    eq(answerFor('dual'), null, 'no answer while disabled');
    event('boot', { desktop: '1.0.0' });
  });
  eq(lines, [], 'nothing logged while disabled');
});

// ── enabled mode: scripted answers ───────────────────────────────────────────
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_ANSWERS: 'dual=accept,backend=upgrade,restart=later' }, () => {
  eq(isEnabled(), true, 'enabled with env');
  capture(() => {
    eq(answerFor('dual'), 0, 'dual=accept → button 0');
    eq(answerFor('backend'), 0, 'backend=upgrade → button 0');
    eq(answerFor('restart'), 1, 'restart=later → button 1');
    eq(answerFor('unknown-prompt'), 1, 'unscripted prompt → defer (button 1)');
  });
});

// ── enabled mode: log lines are single-line parseable JSON ───────────────────
withEnv({ FLOWPAD_UPDATE_TEST: '1', FLOWPAD_UPDATE_TEST_ANSWERS: 'dual=later' }, () => {
  const lines = capture(() => {
    answerFor('dual', { desktop: '9.0.0', desktopLatest: '9.0.1' });
    event('backend-upgraded', { backend: '0.2.52' });
  });
  eq(lines.length, 2, 'two lines logged');
  for (const line of lines) {
    assert.ok(line.startsWith('[update-test] '), `prefix: ${line}`);
    passed++;
  }
  const prompt = JSON.parse(lines[0].slice('[update-test] '.length));
  eq(prompt, {
    event: 'prompt', prompt: 'dual', answer: 1, scripted: true,
    desktop: '9.0.0', desktopLatest: '9.0.1',
  }, 'prompt payload');
  const ev = JSON.parse(lines[1].slice('[update-test] '.length));
  eq(ev, { event: 'backend-upgraded', backend: '0.2.52' }, 'event payload');
});

console.log(`update-test.test.js: ${passed} assertions passed`);
