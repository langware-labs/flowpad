'use strict';

/*
 * What the startup error panel says about a failed install/start.
 *
 * The full dump (env, PATH, uv's whole output) goes to the log; on screen the user needs the
 * command, WHY it stopped, and the lines that name the cause. uv prints its `error:` line
 * FIRST and then, for a build, a long tail of progress — so "the last 6 lines" alone shows
 * only progress and hides the cause (a real report showed exactly that). Pull the lines that
 * carry the cause out of the whole output, then add the tail for context.
 */

const KEY_LINE =
  /^\s*(error\b|×|caused by\b|fatal\b|traceback\b)|\bos error \d+|permission denied|blocked by|application control|failed to (spawn|fetch|download|build|install)|no solution found|not satisfy|unsatisfiable|could not find|no such file/i;

const TAIL_LINES = 6;
const MAX_KEY_LINES = 8;

/** The lines of `text` that name a cause, then the last lines for context. '' when empty. */
function summarizeOutput(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  if (!lines.length) return '';
  const tail = lines.slice(-TAIL_LINES);
  const inTail = new Set(lines.slice(-TAIL_LINES).map((_, i) => lines.length - tail.length + i));
  const key = [];
  lines.forEach((l, i) => {
    if (!inTail.has(i) && KEY_LINE.test(l) && key.length < MAX_KEY_LINES && !key.includes(l)) key.push(l);
  });
  const out = [];
  if (key.length) out.push(`Cause:\n${key.join('\n')}`);
  out.push(`Last output:\n${tail.join('\n')}`);
  return out.join('\n\n');
}

// Windows application control (WDAC / Device Guard / AppLocker) refused to run every launcher the
// app can use. "flow start exited with code 2" says nothing to the person at the keyboard; this
// names the cause and what to ask IT for.
function describePolicyBlock(error) {
  const paths = [...new Set((error.blockedPaths || []).map((p) => (p === 'uv' ? 'uv.exe (the uv package manager)' : p)))];
  return [
    String(error.message).split('\n')[0],
    'Blocked:',
    ...paths.map((p) => `  ${p}`),
    'Ask your IT administrator to allow these programs (or the folders they live in: ' +
      '%USERPROFILE%\\.local\\bin and %APPDATA%\\uv), then click Retry.',
  ].join('\n');
}

// A signal with no uv `error:` line means the process was killed, not that uv failed.
function describeStartupFailure(error) {
  if (error && error.policyBlocked) return describePolicyBlock(error);
  const parts = [String(error?.message || error).split('\n')[0]];
  if (error?.signal) parts.push(`The process was killed (${error.signal}).`);
  else if (typeof error?.code === 'number') parts.push(`Exit code ${error.code}.`);
  const summary = summarizeOutput(error?.stderr ? error.stderr.toString() : '');
  if (summary) parts.push(summary);
  parts.push('Retry keeps what was already downloaded, so a second attempt is usually quick.');
  return parts.join('\n');
}

module.exports = { describeStartupFailure, summarizeOutput };
