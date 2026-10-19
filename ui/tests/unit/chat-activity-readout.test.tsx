/**
 * The vibe/Standard chat activity line's readout: `describeCurrentActivity`
 * picks WHAT to say, `useStickyActivity` decides HOW LONG it stays.
 *
 * Every case here is a bug that actually shipped into review during
 * FLOWPAD-1980 and was proven on a live instance, not a hypothetical. The
 * rules they encode — and the internals behind them — are written up in
 * `docs/breadcrumbs/agent_activity_readout.md`. Read that before changing an
 * expectation here; several of these rules look wrong until you know why the
 * obvious alternative failed.
 */
import { act, renderHook } from '@testing-library/react';
import { FlowData, FlowElementTypes, WorkerStatus } from '@sdk';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { describeCurrentActivity } from '@src/components/entity-execution-panel/current-activity';
import {
  MIN_ACTIVITY_MS,
  useStickyActivity,
} from '@src/components/entity-execution-panel/hooks/useStickyActivity';

const T0 = Date.parse('2026-08-13T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** A TOOL_CALL frame as the backend emits it, with its typed transcript entry. */
function toolCall(
  kind: string,
  fields: Record<string, unknown>,
  opts: { id?: string; observation?: string; ts?: number } = {},
): FlowData {
  const { id = `tool-${kind}`, observation = 'live', ts = 0 } = opts;
  const fd = new FlowData(FlowElementTypes.TOOL_CALL, null, {
    t: at(ts),
    subtype: kind,
    'observation-kind': observation,
    'tool-use-id': id,
  });
  fd.processEntry = {
    observation_kind: observation,
    transcript_entry: { kind, id: `entry-${id}`, ...fields },
  };
  return fd;
}

function reasoning(ts: number): FlowData {
  return new FlowData(FlowElementTypes.REASONING, 'thinking…', { t: at(ts), subtype: 'assistant_message' });
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.agent_activity_readout.rules: FAILING? read this tag's rules before
//       editing — each case is a shipped bug, not a preference
// flowpad:endcapsule tag
describe('describeCurrentActivity', () => {
  it('names the newest operation with its file', () => {
    const activity = describeCurrentActivity([toolCall('file_edit', { path: '/repo/src/foo.ts' })], T0);
    expect(activity?.label).toBe('Editing');
    expect(activity?.detail).toBe('foo.ts');
    // The full path stays available for the tooltip.
    expect(activity?.title).toBe('/repo/src/foo.ts');
  });

  it('prefers the newest call even when the previous one never got a result', () => {
    // Deliberately NOT an "unanswered call" rule: Edit/Read finish within a
    // render, so requiring an unpaired call loses them entirely.
    const activity = describeCurrentActivity(
      [
        toolCall('file_read', { path: '/repo/a.ts' }, { id: 'a', ts: 0 }),
        toolCall('file_edit', { path: '/repo/b.ts' }, { id: 'b', ts: 10 }),
      ],
      T0,
    );
    expect(activity?.detail).toBe('b.ts');
  });

  it('hides a shell command behind a self-contained label', () => {
    const activity = describeCurrentActivity(
      [toolCall('shell_command', { command: 'find . -name "*.ts" | xargs wc -l' })],
      T0,
    );
    expect(activity?.label).toBe('Running command…');
    expect(activity?.detail).toBe('');
    expect(activity?.title).toBe('');
  });

  it('keys two different commands as two different operations', () => {
    // The command is hidden but still distinguishes the operations, so the
    // display floor gives each its own window instead of treating them as one.
    const first = describeCurrentActivity([toolCall('shell_command', { command: 'npm test' }, { id: '' })], T0);
    const second = describeCurrentActivity([toolCall('shell_command', { command: 'npm run build' }, { id: '' })], T0);
    expect(first?.key).not.toBe(second?.key);
  });

  it('says Thinking once the agent is reasoning again', () => {
    // Otherwise the line freezes on the last file the agent touched. This used
    // to return null and lean on the caller's phase label to say "Thinking" —
    // it does not: that label reads `worker_status`, which the transcript tail
    // rarely resolves to THINKING (see thinkingActivity), so the line showed
    // "Working" / "Using tool" straight through the reasoning instead.
    const activity = describeCurrentActivity(
      [toolCall('file_edit', { path: '/repo/foo.ts' }, { ts: 0 }), reasoning(10)],
      T0,
    );
    expect(activity?.label).toBe('Thinking');
    // No object to name, and nothing half-shown from the superseded operation.
    expect(activity?.detail).toBe('');
    expect(activity?.title).toBe('');
  });

  it('says Thinking when the WORKER reports it, with no reasoning frame at all', () => {
    // The frame-based rule above only fires when the model emits a thinking
    // block. Plenty of turns think without one — the newest frame stays the
    // finished tool call and the line sat on "Reading" for as long as the model
    // deliberated. The status is the signal that moves either way. Both signals
    // are kept precisely because each covers the other's blind spot.
    const events = [toolCall('file_read', { path: '/repo/stuck.ts' })];
    expect(describeCurrentActivity(events, T0, WorkerStatus.TOOL_RUNNING)?.detail).toBe('stuck.ts');
    expect(describeCurrentActivity(events, T0, WorkerStatus.THINKING)?.label).toBe('Thinking');
  });

  it('keys every reasoning frame the same, so thinking is ONE operation', () => {
    // The display latch keys on `key`. If consecutive reasoning frames produced
    // different keys each one would restart the minimum-display floor and the
    // readout would stutter; as one key they are a refinement of the same
    // activity, and a real operation after them still wins on its own key.
    const first = describeCurrentActivity([reasoning(10)], T0);
    const second = describeCurrentActivity([reasoning(10), reasoning(20)], T0);
    expect(first?.key).toBe(second?.key);
    expect(describeCurrentActivity([reasoning(10), toolCall('file_read', { path: '/a.ts' }, { ts: 30 })], T0)?.key)
      .not.toBe(first?.key);
  });

  it('ignores replayed history, so a resumed session reports nothing stale', () => {
    // A resumed session hydrates the buffer with the previous transcript. Those
    // frames carry no TOOL_RESULT of their own, so without this cut the
    // previous turn's last operation reads as live forever.
    const activity = describeCurrentActivity(
      [toolCall('file_edit', { path: '/repo/old.ts' }, { observation: 'replay', ts: -60_000 })],
      T0,
    );
    expect(activity).toBeNull();
  });

  it('ignores frames stamped before the current turn started', () => {
    const activity = describeCurrentActivity(
      [toolCall('file_read', { path: '/repo/previous-turn.ts' }, { ts: -5_000 })],
      T0,
    );
    expect(activity).toBeNull();
  });

  it('keeps a frame whose timestamp is unparseable (the cuts fail open)', () => {
    const fd = toolCall('file_read', { path: '/repo/kept.ts' });
    (fd as unknown as { timestamp: string }).timestamp = 'not-a-date';
    expect(describeCurrentActivity([fd], T0)?.detail).toBe('kept.ts');
  });

  // A skill call reaches this function only because the line reads the process
  // stream directly. The chat grouper drops the Skill TOOL_CALL/TOOL_RESULT pair
  // on purpose (MetaMessageChip already shows it, and keeping it inline rendered
  // duplicate chips), so for as long as the line was fed the grouper's output
  // the `skill_call` branch of `gerundFor` was unreachable.
  it('names a skill by the skill it is running', () => {
    const activity = describeCurrentActivity(
      [toolCall('skill_call', { skill_name: 'flowpad-assistance' })],
      T0,
    );
    expect(activity?.label).toBe('Using skill');
    // Not basenamed and not hidden: a skill name is already short and IS the
    // information, unlike a path (basenamed) or a shell command (withheld).
    expect(activity?.detail).toBe('flowpad-assistance');
    expect(activity?.title).toBe('flowpad-assistance');
  });

  // `emit_flow_data` does not forward `process_entry`, so a LIVE frame has no
  // typed transcript entry — only attributes. Every driver stamps `subtype` and
  // `skill-name` on them for exactly this reason. If one stops, this fails here
  // instead of silently degrading to a nameless "Using skill" in production.
  it('names a live skill frame from attributes alone (no process_entry)', () => {
    const fd = new FlowData(FlowElementTypes.TOOL_CALL, JSON.stringify({ tool_call_id: 'tu-skill' }), {
      t: at(0),
      subtype: 'skill_call',
      'observation-kind': 'live',
      'tool-name': 'Skill',
      'tool-use-id': 'tu-skill',
      'skill-name': 'rca',
    });
    const activity = describeCurrentActivity([fd], T0);
    expect(activity?.label).toBe('Using skill');
    expect(activity?.detail).toBe('rca');
    expect(activity?.key).toBe('tu-skill');
  });

  // Previously free: the line was handed the grouper's trailing group, which
  // went empty once that group was a message. Reading the raw stream, the rule
  // has to be stated — without it the readout holds the last tool up through
  // the whole written reply.
  it('stops naming the operation once the agent starts replying', () => {
    const events = [
      toolCall('file_edit', { path: '/repo/foo.ts' }),
      new FlowData(FlowElementTypes.CHAT, 'Here is what I changed…', { t: at(10), role: 'assistant' }),
    ];
    expect(describeCurrentActivity(events, T0)).toBeNull();
  });

  it('still reports a tool the agent ran after replying', () => {
    // Order is what matters, not the mere presence of a message: the agent
    // narrating and THEN acting is the common multi-step turn.
    const events = [
      new FlowData(FlowElementTypes.CHAT, 'Let me check that file.', { t: at(0), role: 'assistant' }),
      toolCall('file_read', { path: '/repo/bar.ts' }, { ts: 10 }),
    ];
    expect(describeCurrentActivity(events, T0)?.detail).toBe('bar.ts');
  });

  // The whole point of the change: the line is handed the process's entire
  // buffer, not a pre-filtered live group, so the scoping has to hold on its
  // own against replayed history AND a previous turn in the same session.
  it('stays turn-scoped when handed the full stream, history included', () => {
    const events = [
      toolCall('file_write', { path: '/repo/replayed.ts' }, { observation: 'replay', ts: -600_000, id: 'r1' }),
      toolCall('file_read', { path: '/repo/previous-turn.ts' }, { ts: -5_000, id: 'p1' }),
      toolCall('file_edit', { path: '/repo/current.ts' }, { ts: 20, id: 'c1' }),
    ];
    expect(describeCurrentActivity(events, T0)?.detail).toBe('current.ts');
  });
});

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.agent_activity_readout.rules: FAILING? read this tag's rules before
//       editing — the 500ms floor and refinement pass-through are proven, not tunable
// flowpad:endcapsule tag
describe('useStickyActivity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const act1 = describeCurrentActivity([toolCall('file_read', { path: '/repo/a.ts' }, { id: 'a' })], T0);
  const act2 = describeCurrentActivity([toolCall('file_edit', { path: '/repo/b.ts' }, { id: 'b' })], T0);

  it('holds an operation for the minimum window before showing the next', () => {
    const { result, rerender } = renderHook(({ a }) => useStickyActivity(a, T0), {
      initialProps: { a: act1 },
    });
    expect(result.current?.detail).toBe('a.ts');

    rerender({ a: act2 });
    expect(result.current?.detail).toBe('a.ts'); // still inside the floor

    act(() => void vi.advanceTimersByTime(MIN_ACTIVITY_MS));
    expect(result.current?.detail).toBe('b.ts');
  });

  it('applies a refinement of the SAME operation immediately', () => {
    // One operation is observed more than once (a PreToolUse hook and the
    // worker's live frame), and the earlier view can arrive before the path is
    // known. Rate-limiting that stranded the line on "Editing" with no
    // filename — the bug this whole hook was nearly broken by.
    const partial = describeCurrentActivity([toolCall('file_edit', {}, { id: 'same' })], T0);
    const complete = describeCurrentActivity([toolCall('file_edit', { path: '/repo/c.ts' }, { id: 'same' })], T0);
    expect(partial?.key).toBe(complete?.key);

    const { result, rerender } = renderHook(({ a }) => useStickyActivity(a, T0), {
      initialProps: { a: partial },
    });
    expect(result.current?.detail).toBe('');

    rerender({ a: complete });
    expect(result.current?.detail).toBe('c.ts'); // no timer advance
  });

  it('skips intermediate operations rather than queueing them', () => {
    // A queue would put the line further and further behind the agent.
    const { result, rerender } = renderHook(({ a }) => useStickyActivity(a, T0), {
      initialProps: { a: act1 },
    });
    rerender({ a: act2 });
    const act3 = describeCurrentActivity([toolCall('file_read', { path: '/repo/d.ts' }, { id: 'd' })], T0);
    rerender({ a: act3 });

    act(() => void vi.advanceTimersByTime(MIN_ACTIVITY_MS));
    expect(result.current?.detail).toBe('d.ts'); // b.ts was never shown
  });

  it('drops a held value the moment the turn changes', () => {
    // A value still inside its window when a turn ends would otherwise carry
    // over and be reported as the NEXT turn's activity.
    const { result, rerender } = renderHook(({ a, turn }) => useStickyActivity(a, turn), {
      initialProps: { a: act1, turn: T0 },
    });
    expect(result.current?.detail).toBe('a.ts');

    rerender({ a: null, turn: T0 + 1_000 });
    expect(result.current).toBeNull(); // immediate, not after the floor
  });
});
