import { AgenticProcess, FlowData, FlowDataSource, FlowElementTypes, dataManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '00000000-0000-4000-8000-0000000000d1';

interface ProcessHistoryInternals {
  flowDataStream: { append(item: FlowData): void };
}

/** Typed view over the opaque `processEntry` payload for assertions. */
function transcriptEntryOf(item: FlowData): { id?: string; kind?: string } | undefined {
  return (item.processEntry as { transcript_entry?: { id?: string; kind?: string } } | null)?.transcript_entry;
}

function processEntry(id: string, kind: string) {
  return {
    transcript_entry: {
      id,
      entry_id: id,
      kind,
      session_id: 'session-d01',
      timestamp: `2026-07-10T06:00:00.${id.slice(-1)}00Z`,
      worker: 'codex',
    },
    observation_kind: 'replay',
    received_at: '2026-07-10T06:01:00.000Z',
  };
}

function historyItem(
  id: string,
  elementType: string,
  flowValue: unknown,
  timestamp: string,
  extraAttributes: Record<string, string> = {},
) {
  const kind = extraAttributes.subtype ?? (elementType === FlowElementTypes.USER_MESSAGE ? 'user_message' : 'tool_use');
  return {
    flow_value: flowValue,
    created_time: timestamp,
    attributes: {
      'element-type': elementType,
      'data-type': typeof flowValue === 'string' ? 'string' : 'object',
      'transcript-entry-id': id,
      subtype: kind,
      ...extraAttributes,
    },
    process_entry: processEntry(id, kind),
  };
}

describe('AgenticProcess canonical history replay', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    callActionSpy = vi.spyOn(dataManager, 'callAction');
  });

  afterEach(() => {
    callActionSpy.mockRestore();
  });

  it('retires the optimistic echo when history replays the same user message', async () => {
    // The bug: `appendUserMessage` stamps the echo when the user hits SUBMIT and
    // gives it no transcript id; the persisted row carries the id and the
    // backend's RECORD time. Neither reconcile tier can match them, so the
    // non-forced replay appended a second copy and the pane showed "hi" twice.
    const history = [
      historyItem('user-1', FlowElementTypes.USER_MESSAGE, 'hi', '2026-07-10T06:00:12.275Z', {
        role: 'user',
        subtype: 'user_message',
      }),
      historyItem('chat-1', FlowElementTypes.CHAT, 'Hey!', '2026-07-10T06:00:14.142Z', {
        role: 'assistant',
        subtype: 'assistant_message',
      }),
    ];
    callActionSpy.mockResolvedValue({
      history,
      count: history.length,
      session_id: 'session-echo',
      use_worker_history: true,
    } as never);
    const process = new AgenticProcess({ id: PROCESS_ID });
    // Submit-time echo: same text, earlier clock, no transcript id.
    process.appendUserMessage('hi');
    expect(process.getOutputs()).toHaveLength(1);

    await process.loadHistory();

    const userRows = process.getOutputs().filter((item) => item.elementType === FlowElementTypes.USER_MESSAGE);
    expect(userRows).toHaveLength(1);
    // The survivor is the persisted row, not the placeholder.
    expect(transcriptEntryOf(userRows[0])?.id).toBe('user-1');
  });

  it('keeps an echo the replay does not carry — a message sent while the fetch was in flight', async () => {
    // The retract pairs each echo with a history row by content. An echo minted
    // AFTER the request went out has no counterpart in the payload, so it must
    // survive: retiring every echo whenever history mentions any user message
    // would erase the message the user just typed until the next reload.
    const history = [
      historyItem('user-1', FlowElementTypes.USER_MESSAGE, 'first', '2026-07-10T06:00:10.000Z', {
        role: 'user',
        subtype: 'user_message',
      }),
    ];
    callActionSpy.mockResolvedValue({
      history,
      count: history.length,
      session_id: 'session-inflight',
      use_worker_history: true,
    } as never);
    const process = new AgenticProcess({ id: PROCESS_ID });
    process.appendUserMessage('first'); // persisted — retired by the replay
    process.appendUserMessage('second'); // typed mid-flight — nothing to pair with

    await process.loadHistory();

    const userRows = process.getOutputs().filter((item) => item.elementType === FlowElementTypes.USER_MESSAGE);
    expect(userRows.map((item) => item.content)).toEqual(['first', 'second']);
    expect(transcriptEntryOf(userRows[0])?.id).toBe('user-1');
  });

  it('force reload preserves complete repeated turns, adjacent chats, objects, and typed identity', async () => {
    const history = [
      historyItem('user-1', FlowElementTypes.USER_MESSAGE, 'same prompt', '2026-07-10T06:00:00.100Z', {
        role: 'user',
        subtype: 'user_message',
      }),
      historyItem('user-2', FlowElementTypes.USER_MESSAGE, 'same prompt', '2026-07-10T06:00:00.200Z', {
        role: 'user',
        subtype: 'user_message',
      }),
      historyItem('user-3', FlowElementTypes.USER_MESSAGE, 'same prompt', '2026-07-10T06:00:00.300Z', {
        role: 'user',
        subtype: 'user_message',
      }),
      historyItem('chat-1', FlowElementTypes.CHAT, 'commentary', '2026-07-10T06:00:00.400Z', {
        role: 'assistant',
        subtype: 'assistant_message',
        phase: 'commentary',
      }),
      historyItem('chat-2', FlowElementTypes.CHAT, 'final', '2026-07-10T06:00:00.500Z', {
        role: 'assistant',
        subtype: 'assistant_message',
        phase: 'final_answer',
      }),
      historyItem(
        'tool-1',
        FlowElementTypes.TOOL_CALL,
        { tool_name: 'exec_command', tool_call_id: 'call-1', args: { cmd: 'printf ok' } },
        '2026-07-10T06:00:00.600Z',
        { subtype: 'tool_use', 'tool-use-id': 'call-1' },
      ),
    ];
    callActionSpy.mockResolvedValue({
      history,
      count: history.length,
      session_id: 'session-d01',
      use_worker_history: true,
    } as never);
    const process = new AgenticProcess({ id: PROCESS_ID });
    process.appendUserMessage('undelivered prompt');

    await process.loadHistory({ force: true });

    const outputs = process.getOutputs();
    // The echo survives: history carries no row for it, so it is a message still
    // in flight, not a stale duplicate — same rule the non-forced path applies.
    expect(outputs).toHaveLength(history.length + 1);
    expect(outputs.at(-1)?.content).toBe('undelivered prompt');
    expect(outputs.filter((item) => item.content === 'same prompt')).toHaveLength(3);
    expect(outputs.filter((item) => item.elementType === FlowElementTypes.CHAT).map((item) => item.content)).toEqual([
      'commentary',
      'final',
    ]);
    const tool = outputs.find((item) => item.elementType === FlowElementTypes.TOOL_CALL)!;
    expect(tool.data).toEqual({
      tool_name: 'exec_command',
      tool_call_id: 'call-1',
      args: { cmd: 'printf ok' },
    });
    expect(transcriptEntryOf(tool)).toMatchObject({ id: 'tool-1', kind: 'tool_use' });
    expect(tool.timestamp).toBe('2026-07-10T06:00:00.600Z');
    // Every TRANSCRIPT row is tagged History; the carried-over echo is a live
    // placeholder by definition — it has no transcript row to be tagged from.
    expect(
      outputs.filter((item) => !item.isOptimisticEcho).every((item) => item.source === FlowDataSource.History),
    ).toBe(true);
  });

  it('non-force replay reconciles live overlap one-for-one without erasing repeated content', async () => {
    const timestamp = '2026-07-10T06:00:00.100Z';
    const history = [
      historyItem('user-1', FlowElementTypes.USER_MESSAGE, 'same prompt', timestamp, {
        role: 'user',
        subtype: 'user_message',
      }),
      historyItem('user-2', FlowElementTypes.USER_MESSAGE, 'same prompt', '2026-07-10T06:00:00.200Z', {
        role: 'user',
        subtype: 'user_message',
      }),
      historyItem('user-3', FlowElementTypes.USER_MESSAGE, 'same prompt', '2026-07-10T06:00:00.300Z', {
        role: 'user',
        subtype: 'user_message',
      }),
    ];
    callActionSpy.mockResolvedValue({
      history,
      count: history.length,
      session_id: 'session-d01',
      use_worker_history: true,
    } as never);
    const process = new AgenticProcess({ id: PROCESS_ID });
    const live = FlowData.fromJSON(history[0]);
    live.source = FlowDataSource.Stream;
    live.markReady();
    (process as unknown as ProcessHistoryInternals).flowDataStream.append(live);

    await process.loadHistory();

    const outputs = process.getOutputs();
    expect(outputs).toHaveLength(3);
    expect(outputs.map((item) => transcriptEntryOf(item)?.id)).toEqual(['user-1', 'user-2', 'user-3']);
    expect(outputs.filter((item) => item.content === 'same prompt')).toHaveLength(3);
    expect(outputs.filter((item) => item.source === FlowDataSource.Stream)).toHaveLength(1);
    expect(outputs.filter((item) => item.source === FlowDataSource.History)).toHaveLength(2);
  });

  it('id-less rows sharing elementType|role|timestamp|content reconcile one-for-one to max(live, history)', async () => {
    // Pins the documented invariant on `reconcileHistoryOverlap`: without a
    // transcript id, K live rows and M history rows colliding on all four
    // fallback fields must yield max(K, M) rows — the one live observation
    // absorbs exactly ONE history row, never the whole bucket.
    const timestamp = '2026-07-10T06:00:00.100Z';
    const idlessRow = {
      flow_value: 'same prompt',
      created_time: timestamp,
      attributes: {
        'element-type': FlowElementTypes.USER_MESSAGE,
        'data-type': 'string',
        role: 'user',
      },
    };
    const history = [idlessRow, { ...idlessRow }, { ...idlessRow }];
    callActionSpy.mockResolvedValue({
      history,
      count: history.length,
      session_id: 'session-d01',
      use_worker_history: true,
    } as never);
    const process = new AgenticProcess({ id: PROCESS_ID });
    const live = FlowData.fromJSON(idlessRow);
    live.source = FlowDataSource.Stream;
    live.markReady();
    (process as unknown as ProcessHistoryInternals).flowDataStream.append(live);

    await process.loadHistory();

    const outputs = process.getOutputs();
    expect(outputs).toHaveLength(3); // max(1 live, 3 history), not 1 and not 4
    expect(outputs.filter((item) => item.content === 'same prompt')).toHaveLength(3);
    expect(outputs.filter((item) => item.source === FlowDataSource.Stream)).toHaveLength(1);
    expect(outputs.filter((item) => item.source === FlowDataSource.History)).toHaveLength(2);
  });
});

describe('FlowData.fromJSON non-string flow_value (history ingestion path)', () => {
  it('serializes object flow_value into string content and parses it back per data-type', () => {
    const payload = { tool_name: 'exec_command', args: { cmd: 'printf ok' } };
    const objectRow = FlowData.fromJSON({
      flow_value: payload,
      created_time: '2026-07-10T06:00:00.100Z',
      attributes: { 'element-type': FlowElementTypes.TOOL_CALL, 'data-type': 'object' },
    });
    // `content` must be a real string (previews, reconcile fallback keys and
    // parseChunk all assume it); `data` round-trips to the object.
    expect(objectRow.content).toBe(JSON.stringify(payload));
    expect(objectRow.data).toEqual(payload);
  });

  it('stringifies non-string flow_value even for string-typed rows instead of leaking a raw object', () => {
    const stray = { note: 'backend sent an object on a string row' };
    const row = FlowData.fromJSON({
      flow_value: stray,
      created_time: '2026-07-10T06:00:00.200Z',
      attributes: { 'element-type': FlowElementTypes.CHAT, 'data-type': 'string' },
    });
    expect(typeof row.content).toBe('string');
    expect(row.content).toBe(JSON.stringify(stray));
  });
});
