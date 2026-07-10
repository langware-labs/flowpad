import {
  AgenticProcess,
  FlowData,
  FlowDataSource,
  FlowElementTypes,
  dataManager,
} from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '00000000-0000-4000-8000-0000000000d1';

interface ProcessHistoryInternals {
  flowDataStream: { append(item: FlowData): void };
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
    process.appendUserMessage('stale optimistic row');

    await process.loadHistory({ force: true });

    const outputs = process.getOutputs();
    expect(outputs).toHaveLength(history.length);
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
    expect(tool.process_entry?.transcript_entry).toMatchObject({ id: 'tool-1', kind: 'tool_use' });
    expect(tool.created_time).toBe('2026-07-10T06:00:00.600Z');
    expect(outputs.every((item) => item.source === FlowDataSource.History)).toBe(true);
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
    expect(outputs.map((item) => item.process_entry?.transcript_entry?.id)).toEqual([
      'user-1',
      'user-2',
      'user-3',
    ]);
    expect(outputs.filter((item) => item.content === 'same prompt')).toHaveLength(3);
    expect(outputs.filter((item) => item.source === FlowDataSource.Stream)).toHaveLength(1);
    expect(outputs.filter((item) => item.source === FlowDataSource.History)).toHaveLength(2);
  });
});
