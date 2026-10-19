import { AgenticProcess, FlowDataSource, FlowElementTypes, TypeId, dataManager } from '@sdk';
import { FlowData } from '@sdk/flow_processing';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * FLOWPAD-2196 — "Sometimes user prompt can't be seen until full refresh".
 *
 * Re-sending text the conversation already holds ("yes", "continue") rendered
 * nothing for the new turn: `prompt()` echoes it via `appendUserMessage`, whose
 * own guard only looks at pending echoes — but `FlowDataStream.ingest()` then
 * drops ANY user message whose role+content matches an earlier row, including
 * the persisted one from history. Nothing re-fetches history for a turn this
 * pane sent, so the row appears only after a reload.
 */

const PROC_ID = '00000000-0000-4000-8000-0000000021a6';
const PROC_TYPEID = new TypeId(AgenticProcess.type, PROC_ID);

/** The earlier turn, built exactly as `loadHistory()` builds a transcript row. */
function persisted(id: string, elementType: string, role: string, text: string, t: string): FlowData {
  const row = FlowData.fromJSON({
    flow_value: text,
    created_time: t,
    attributes: { 'element-type': elementType, 'data-type': 'string', role, 'transcript-entry-id': id },
  });
  row.markReady();
  row.source = FlowDataSource.History;
  return row;
}

let rendered: FlowData[] = [];
function Harness({ process }: { process: AgenticProcess }) {
  rendered = useAgenticProcessStream(process);
  return null;
}

const userTurns = () =>
  rendered.filter((i) => i.elementType === FlowElementTypes.USER_MESSAGE).map((i) => i.content);

describe('re-sending an earlier prompt', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    cleanup();
    await dataManager.clearCache();
  });

  it('renders the new user turn even when its text matches an earlier persisted one', async () => {
    const ap = new AgenticProcess({ id: PROC_ID, pty_mode: false, visible: false });
    dataManager.register_new_entity(PROC_TYPEID, ap);
    ap.flowDataStream.append([
      persisted('u1', FlowElementTypes.USER_MESSAGE, 'user', 'yes', '2026-09-30T10:00:00.000Z'),
      persisted('c1', FlowElementTypes.CHAT, 'assistant', 'Done.', '2026-09-30T10:00:01.000Z'),
    ]);
    render(<Harness process={ap} />);
    expect(userTurns()).toEqual(['yes']);

    // The real send path. The echo is ingested before the request goes out;
    // the unit tier has no backend, so the request itself fails afterwards.
    await act(async () => {
      await ap.prompt('yes').catch(() => {});
    });

    expect(userTurns()).toEqual(['yes', 'yes']);
  });
});

describe('double-submit guard is scoped to the turn in flight', () => {
  /** The turn terminator the prompt stream delivers when a turn finishes. */
  const turnEnd = () =>
    FlowData.fromJSON({ flow_value: '', attributes: { 'element-type': FlowElementTypes.END, 'data-type': 'string' } });
  const echoes = (ap: AgenticProcess) => ap.getOutputs().filter((i) => i.isOptimisticEcho).map((i) => i.content);

  it('echoes the same text again once the previous turn has ended', async () => {
    const ap = new AgenticProcess({ id: PROC_ID, pty_mode: false, visible: false });
    await ap.prompt('pong').catch(() => {});
    ap.flowDataStream.ingest(turnEnd());

    await ap.prompt('pong').catch(() => {});

    expect(echoes(ap)).toEqual(['pong', 'pong']);
  });

  it('still drops a double-submit of the same text within one turn', async () => {
    const ap = new AgenticProcess({ id: PROC_ID, pty_mode: false, visible: false });
    await ap.prompt('pong').catch(() => {});

    await ap.prompt('pong').catch(() => {});

    expect(echoes(ap)).toEqual(['pong']);
  });
});

describe('user-message dedupe is by transcript id, not text', () => {
  /** A user row as a live channel (WS / observe-turn) delivers it: id only as an attribute. */
  function live(id: string, text: string): FlowData {
    return FlowData.fromJSON({
      flow_value: text,
      attributes: {
        'element-type': FlowElementTypes.USER_MESSAGE,
        'data-type': 'string',
        role: 'user',
        'transcript-entry-id': id,
        'observation-kind': 'live',
      },
    });
  }
  const users = (ap: AgenticProcess) =>
    ap.getOutputs().filter((i) => i.elementType === FlowElementTypes.USER_MESSAGE);

  it('keeps a live turn whose text repeats an earlier persisted one (after a reload)', () => {
    const ap = new AgenticProcess({ id: PROC_ID });
    ap.flowDataStream.append([persisted('u1', FlowElementTypes.USER_MESSAGE, 'user', 'yes', '2026-09-30T10:00:00.000Z')]);

    ap.handleFlowData(live('u2', 'yes'));

    expect(users(ap).map((u) => u.transcriptEntryId)).toEqual(['u1', 'u2']);
  });

  it('drops the same transcript entry delivered again', () => {
    const ap = new AgenticProcess({ id: PROC_ID });
    ap.flowDataStream.append([persisted('u1', FlowElementTypes.USER_MESSAGE, 'user', 'yes', '2026-09-30T10:00:00.000Z')]);

    ap.handleFlowData(live('u1', 'yes'));

    expect(users(ap).map((u) => u.transcriptEntryId)).toEqual(['u1']);
  });
});
