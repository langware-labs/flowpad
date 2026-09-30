'use strict';

/*
 * Tests for ./startup-error.js — what the startup error panel shows.
 * Run: `node electron/startup-error.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { describeStartupFailure, summarizeOutput } = require('./startup-error');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

// uv prints its `error:` line FIRST, then a long progress tail (real report: the panel showed
// only progress and the cause was cut off).
const progress = Array.from({ length: 30 }, (_, i) => `Downloading package-${i} (1.${i}MiB)`);
const uvFailure = [
  'error: Failed to build `pybars3==0.9.7`',
  '  Caused by: The build backend returned an error',
  ...progress,
].join('\n');

{
  const s = summarizeOutput(uvFailure);
  ok(s.includes('Failed to build `pybars3==0.9.7`'), 'the uv error line survives although it is far from the tail');
  ok(s.includes('Caused by: The build backend returned an error'), 'the Caused-by line survives');
  ok(s.includes('Cause:') && s.includes('Last output:'), 'cause block, then the tail for context');
  ok(s.includes('package-29'), 'the tail is still there');
  ok(!s.includes('package-3 '), 'the middle of the progress output is dropped');
}
{
  const s = summarizeOutput('error: boom\nline2\nline3');
  eq(s, 'Last output:\nerror: boom\nline2\nline3', 'short output: no duplicated cause block');
}
{
  const wdac = [
    'error: Failed to spawn: `flow`',
    '  Caused by: An Application Control policy has blocked this file. (os error 4551)',
    ...progress,
  ].join('\n');
  const s = summarizeOutput(wdac);
  ok(s.includes('os error 4551') && s.includes('Application Control'), 'a policy block (WDAC) is named in the panel');
}
{
  const many = Array.from({ length: 40 }, (_, i) => `error: cause number ${i}`).concat(progress).join('\n');
  const causeLines = summarizeOutput(many).split('\n\n')[0].split('\n').length - 1;
  ok(causeLines <= 8, `the cause block is capped (${causeLines} lines)`);
}
eq(summarizeOutput(''), '', 'empty output → nothing');
eq(summarizeOutput(null), '', 'null output → nothing');
eq(summarizeOutput('  \n\n'), '', 'blank output → nothing');

{
  const e = Object.assign(new Error('Command failed: uv tool install flowpad --python 3.11 --force\nlong second line'), {
    code: 2, stderr: uvFailure,
  });
  const d = describeStartupFailure(e);
  ok(d.startsWith('Command failed: uv tool install flowpad --python 3.11 --force\n'), 'first line of the message only');
  ok(!d.includes('long second line'), 'the rest of the message is not repeated');
  ok(d.includes('Exit code 2.'), 'exit code is shown');
  ok(d.includes('pybars3'), 'the cause is shown');
  ok(d.endsWith('a second attempt is usually quick.'), 'retry hint last');
}
{
  const d = describeStartupFailure(Object.assign(new Error('Command failed: uv'), { signal: 'SIGTERM' }));
  ok(d.includes('The process was killed (SIGTERM).') && !d.includes('Exit code'), 'a signal is reported as a kill, with no exit code');
}
{
  const d = describeStartupFailure('plain string error');
  ok(d.startsWith('plain string error'), 'a non-Error value is tolerated');
}

console.log(`startup-error.test.js: ${passed} assertions passed`);
