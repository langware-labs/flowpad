/**
 * `ChatActivityLine` sources its own events.
 *
 * The line takes a process and nothing else: it subscribes to that process's
 * `flowDataStream` and derives the phase, the clock anchor and the named
 * operation itself. These cases exist because the line USED to be handed those
 * as props, computed in each pane from the chat grouper's output — and the
 * grouper deliberately drops the frames of any operation the chat represents
 * elsewhere. A skill call is exactly that: `MetaMessageChip` already renders
 * "Using skill: <name>", so the Skill TOOL_CALL/TOOL_RESULT pair is dropped,
 * and for as long as the line read grouped output it could never name a skill.
 *
 * See `docs/breadcrumbs/agent_activity_readout.md` for the rules the readout
 * itself obeys; this file only covers where its data comes from.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { FlowData, FlowDataStream, FlowElementTypes, WorkerStatus } from '@sdk';
import { afterEach, describe, it, expect, vi } from 'vitest';

// The only mock. `useTurnActivity` reflects the entity over the websocket to
// keep `busy`/`worker_status` live; in a unit test that would reach the
// network. Returning null makes it fall back to the passed process, which is
// the object these tests control. Everything else — the stream subscription,
// the prompting latch, describeCurrentActivity, useStickyActivity — is real.
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: null }),
  useWatch: () => {},
}));

import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';

const T0 = Date.parse('2026-08-19T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** A live Skill TOOL_CALL exactly as the backend emits it mid-turn: attributes
 *  only, no `process_entry` (emit_flow_data does not forward it). */
function liveSkillCall(skill: string, id = 'tu-skill'): FlowData {
  return new FlowData(FlowElementTypes.TOOL_CALL, JSON.stringify({ tool_call_id: id, skill_name: skill }), {
    t: at(50),
    subtype: 'skill_call',
    'observation-kind': 'live',
    'tool-name': 'Skill',
    'tool-use-id': id,
    'skill-name': skill,
  });
}

function userMessage(): FlowData {
  return new FlowData(FlowElementTypes.USER_MESSAGE, 'go', { t: at(0), role: 'user' });
}

/** Minimal AgenticProcess stand-in: a real stream plus the fields the line and
 *  `useTurnActivity` actually read. */
function fakeProcess(opts: { busy?: boolean; frames?: FlowData[] } = {}) {
  const { busy = true, frames = [] } = opts;
  const stream = new FlowDataStream('chat-activity-line-test');
  if (frames.length) stream.ingestBatch(frames);
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    id: 'p-1',
    session_id: 's-1',
    status: 'running',
    busy,
    workerStatus: WorkerStatus.TOOL_CALL,
    isPrompting: false,
    flowDataStream: stream,
    on(evt: string, cb: (...a: unknown[]) => void) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt)!.add(cb);
      return () => listeners.get(evt)!.delete(cb);
    },
    off(evt: string, cb: (...a: unknown[]) => void) {
      listeners.get(evt)?.delete(cb);
    },
  };
}

const renderLine = (process: ReturnType<typeof fakeProcess>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<ChatActivityLine process={process as any} />);

describe('ChatActivityLine sources its own events', () => {
  // The unit tier has no global RTL cleanup (the react tier does), and every
  // case here queries by testid — without this the second render finds two.
  afterEach(cleanup);

  it('names a live skill from the process stream, with no activity props', () => {
    // The whole point: one prop in, "Using skill · rca" out. Nothing computed
    // this for the component, and no grouper sat between.
    renderLine(fakeProcess({ frames: [userMessage(), liveSkillCall('rca')] }));

    expect(screen.getByTestId('chat-activity-label').textContent).toBe('Using skill');
    expect(screen.getByTestId('chat-activity-detail').textContent).toBe('rca');
  });

  it('follows a frame that arrives after mount, with no parent re-render', () => {
    // Proof the line is subscribed rather than fed: nothing re-renders it, the
    // stream simply emits and the readout moves.
    const process = fakeProcess({ frames: [userMessage()] });
    renderLine(process);
    expect(screen.getByTestId('chat-activity-label').textContent).not.toContain('Using skill');

    act(() => {
      process.flowDataStream.ingest(liveSkillCall('flowpad-assistance', 'tu-2'));
    });

    expect(screen.getByTestId('chat-activity-label').textContent).toBe('Using skill');
    expect(screen.getByTestId('chat-activity-detail').textContent).toBe('flowpad-assistance');
  });

  it('renders nothing when no turn is in flight', () => {
    renderLine(fakeProcess({ busy: false, frames: [userMessage(), liveSkillCall('rca')] }));
    expect(screen.queryByTestId('chat-activity-line')).toBeNull();
  });

  it('falls back to the phase label when no operation is the current story', () => {
    // A skill call the agent has already finished talking past: the readout
    // hands back to the coarse phase word rather than asserting a stale op.
    const frames = [
      userMessage(),
      liveSkillCall('rca'),
      new FlowData(FlowElementTypes.CHAT, 'Here is what the skill said…', { t: at(80), role: 'assistant' }),
    ];
    renderLine(fakeProcess({ frames }));

    expect(screen.queryByTestId('chat-activity-line')).not.toBeNull();
    expect(screen.queryByTestId('chat-activity-detail')).toBeNull();
    expect(screen.getByTestId('chat-activity-label').textContent).not.toContain('Using skill');
  });
});
