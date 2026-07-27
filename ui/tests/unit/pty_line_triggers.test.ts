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
  (pc as unknown as { _attached: boolean })._attached = true;
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

  it('emits ANSI-stripped terminal redraw rows delimited by bare \\r', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('\x1b[H\x1b[31m❯ where is the plan some.md?\x1b[0m\r\x1b[3BWorking\rnext'));

    expect(lines).toEqual(['❯ where is the plan some.md?', 'Working']);
  });

  it('coalesces CRLF split across chunks into one boundary', () => {
    const pc = makePty();
    const lines: string[] = [];
    pc.onLine((l) => lines.push(l));

    pc.appendOutput(b64('hello\r'));
    expect(lines).toEqual([]);

    pc.appendOutput(b64('\nworld\rnext'));
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
    // _attached defaults to false — onOutput would NOT fire, but onLine should.
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

  it('matches a Claude-style terminal redraw row delimited by bare CR', () => {
    const pc = makePty();
    const matches: string[] = [];
    pc.addTrigger({
      pattern: /plan some\.md/i,
      onMatch: (_line, m) => matches.push(m[0]),
    });

    pc.appendOutput(b64('\x1b[H\x1b[38;2;255;255;255m❯ where is the plan some.md?\x1b[39m\r\x1b[3B'));

    expect(matches).toEqual(['plan some.md']);
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

  it('catches up on history when registered after replay (synthesized fires flagged duringReplay)', () => {
    const pc = makePty();
    // Feed lines BEFORE registering the trigger — simulates the reload race
    // where InteractiveTerminal's useEffect calls addTrigger after attach()
    // has already drained replayed chunks through the line buffer. Real chunks
    // arrive with seq numbers from the server; pass them so they land in the
    // ``chunks`` map (the catchup source).
    pc.appendOutput(b64('boring banner line\n'), 1);
    pc.appendOutput(b64('Wrote plan-alpha.md\n'), 2);
    pc.appendOutput(b64('another line\n'), 3);
    pc.appendOutput(b64('finally plan-beta.md too\n'), 4);

    const matches: { line: string; group: string }[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      label: 'late-binding',
      onMatch: (line, m) => matches.push({ line, group: m[0] }),
    });

    expect(matches.length).toBe(2);
    expect(matches[0].group).toBe('plan-alpha.md');
    expect(matches[1].group).toBe('plan-beta.md');

    const fires = pc.getEventFires();
    expect(fires.length).toBe(2);
    expect(fires.every((f) => f.duringReplay)).toBe(true);
    expect(fires.every((f) => f.label === 'late-binding')).toBe(true);
  });

  it('catches up on bare-CR terminal rows from replay', () => {
    const pc = makePty();
    pc.appendOutput(b64('\x1b[H❯ where is the plan replay.md?\r\x1b[3BWorking\r'), 1);

    const matches: string[] = [];
    pc.addTrigger({
      pattern: /plan replay\.md/i,
      label: 'redraw-replay',
      onMatch: (_line, m) => matches.push(m[0]),
    });

    expect(matches).toEqual(['plan replay.md']);
    expect(pc.getEventFires()).toEqual([
      expect.objectContaining({
        label: 'redraw-replay',
        duringReplay: true,
        line: expect.stringContaining('plan replay.md'),
      }),
    ]);
  });

  it('catchup does not double-fire on subsequent live chunks', () => {
    const pc = makePty();
    pc.appendOutput(b64('plan-alpha.md\n'), 1);

    const matches: string[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      onMatch: (_l, m) => matches.push(m[0]),
    });
    expect(matches).toEqual(['plan-alpha.md']);

    pc.appendOutput(b64('plan-beta.md\n'), 2);
    expect(matches).toEqual(['plan-alpha.md', 'plan-beta.md']);
  });

  it('catchup is per-trigger — only the new trigger sees history', () => {
    const pc = makePty();
    pc.appendOutput(b64('plan-alpha.md\n'), 1);

    const firstMatches: string[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      label: 'first',
      onMatch: (_l, m) => firstMatches.push(m[0]),
    });
    expect(firstMatches).toEqual(['plan-alpha.md']);

    const secondMatches: string[] = [];
    pc.addTrigger({
      pattern: /plan[\w-]*\.md/i,
      label: 'second',
      onMatch: (_l, m) => secondMatches.push(m[0]),
    });

    expect(firstMatches).toEqual(['plan-alpha.md']); // unchanged
    expect(secondMatches).toEqual(['plan-alpha.md']);
  });
});
