/**
 * Unit tests for PtyConnection.onLine + addTrigger.
 *
 * Feeds synthetic base64-encoded chunks directly into ``appendOutput`` and
 * asserts the line-buffer/ANSI-strip/trigger pipeline behaves correctly —
 * no backend, no Claude, no WebSocket.
 */

import { PtyConnection } from '@sdk/services/shell/ptyConnection';
import { describe, expect, it } from 'vitest';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

function makePty(): PtyConnection {
  const pc = new PtyConnection('test-shell', 'test-node');
  // Lift the post-replay gate so onOutput would also fire — irrelevant for
  // line listeners (which fire regardless), but keeps the test surface clean.
  (pc as unknown as { _replayDone: boolean })._replayDone = true;
  return pc;
}

describe('PtyConnection.onLine', () => {
  it('emits one line per \\n in the stream', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('hello\nworld\n'));

    expect(lines).toEqual(['hello', 'world']);
  });

  it('buffers a partial line until the next chunk arrives', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('partial '));
    expect(lines).toEqual([]);

    pc.appendOutput(b64('continued\n'));
    expect(lines).toEqual(['partial continued']);
  });

  it('strips CSI ANSI escape sequences before emitting', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    // Color a path with red SGR codes; line emitter must strip them.
    pc.appendOutput(b64('Wrote \x1b[31m/Users/x/.claude/plans/foo.md\x1b[0m now\n'));

    expect(lines).toEqual(['Wrote /Users/x/.claude/plans/foo.md now']);
  });

  it('handles \\r\\n line endings (drops the \\r)', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('hello\r\nworld\r\n'));

    expect(lines).toEqual(['hello', 'world']);
  });

  it('clear() resets the line buffer (no carryover after reattach)', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('half'));
    pc.clear();
    pc.appendOutput(b64('whole\n'));

    expect(lines).toEqual(['whole']);
  });

  it('fires line listeners even when replay is not done (replay-inclusive)', () => {
    const pc = new PtyConnection('test-shell', 'test-node');
    // _replayDone defaults to false — onOutput would NOT fire, but onLine should.
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('replay-line\n'));

    expect(lines).toEqual(['replay-line']);
  });

  it('unsubscribe stops the listener', () => {
    const pc = makePty();
    const lines: string[] = [];
    const unsub = pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('first\n'));
    unsub();
    pc.appendOutput(b64('second\n'));

    expect(lines).toEqual(['first']);
  });
});

describe('PtyConnection.addTrigger', () => {
  it('fires only on lines matching the regex', () => {
    const pc = makePty();
    const matches: { line: string; group: string | undefined }[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      onMatch: (line, m) => {
        matches.push({ line, group: m[0] });
      },
    });

    pc.appendOutput(b64('boring line\n'));
    pc.appendOutput(b64('Wrote plan to /Users/x/.claude/plans/sample-plan.md ok\n'));
    pc.appendOutput(b64('another boring line\n'));

    expect(matches.length).toBe(1);
    expect(matches[0].line).toContain('sample-plan.md');
    // The captured group is the matched substring — the regex consumes
    // from the leading "plan" through ".md" greedily on \w-, so it picks
    // up "plan.md" inside "/Users/.../sample-plan.md".
    expect(matches[0].group).toBe('plan.md');
  });

  it('matches against ANSI-stripped text, not raw bytes', () => {
    const pc = makePty();
    const matches: string[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      onMatch: (_line, m) => matches.push(m[0]),
    });

    // SGR codes injected mid-path would defeat a naive matcher.
    pc.appendOutput(b64('see \x1b[36mplan-x\x1b[0m\x1b[36m.md\x1b[0m here\n'));

    expect(matches).toEqual(['plan-x.md']);
  });

  it('multiple triggers on the same connection are independent', () => {
    const pc = makePty();
    const planMatches: string[] = [];
    const errMatches: string[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      onMatch: (_l, m) => planMatches.push(m[0]),
    });
    pc.addTrigger({
      pattern: /\bERROR\b/,
      onMatch: (_l, m) => errMatches.push(m[0]),
    });

    pc.appendOutput(b64('see plan-x.md and ERROR happened\n'));

    expect(planMatches).toEqual(['plan-x.md']);
    expect(errMatches).toEqual(['ERROR']);
  });

  it('unsubscribed trigger no longer fires', () => {
    const pc = makePty();
    const matches: string[] = [];
    const unsub = pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      onMatch: (_l, m) => matches.push(m[0]),
    });

    pc.appendOutput(b64('first plan-x.md here\n'));
    unsub();
    pc.appendOutput(b64('second plan-y.md here\n'));

    expect(matches).toEqual(['plan-x.md']);
  });
});
