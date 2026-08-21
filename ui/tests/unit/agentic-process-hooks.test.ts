import {
  AgenticProcess,
  type AgentHookData,
  FlowData,
  FlowElementTypes,
  FSRef,
  HookEventType,
  dataManager,
} from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '00000000-0000-4000-8000-000000000001';

function hookData(processId = PROCESS_ID): AgentHookData {
  return {
    webhook_type: 'agent_hook',
    agentic_process_id: processId,
    hook_data: {
      hook_event_name: HookEventType.USER_PROMPT_SUBMIT,
      prompt: 'line one\nline two',
    },
  };
}

beforeEach(async () => {
  await dataManager.clearCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataManager.clearCache();
});

describe('AgenticProcess process hooks', () => {
  it.each([
    ['setHook', 'set-hook', true],
    ['removeHook', 'remove-hook', false],
  ] as const)('%s uses the process action and returns changed', async (method, actionName, changed) => {
    const callAction = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ changed });
    const process = new AgenticProcess({ id: PROCESS_ID });

    const result = await process[method](HookEventType.USER_PROMPT_SUBMIT);

    expect(result).toBe(changed);
    const action = callAction.mock.calls[0][0];
    expect(action.name).toBe(actionName);
    expect(action.targetEntity?.type).toBe(AgenticProcess.type);
    expect(action.targetEntity?.id).toBe(PROCESS_ID);
    expect(action.bodyParameters).toEqual({ event: HookEventType.USER_PROMPT_SUBMIT });
  });

  it('dispatches a stable callback snapshot in registration order and isolates failures', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID });
    const seen: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let unsubscribeSecond = () => undefined;
    const unsubscribeFirst = process.registerCallback(() => {
      seen.push('first');
      unsubscribeSecond();
      throw new Error('isolated');
    });
    unsubscribeSecond = process.registerCallback(async () => {
      await Promise.resolve();
      seen.push('second');
    });

    await process.onHook(hookData());
    await process.onHook(hookData());
    unsubscribeFirst();
    unsubscribeFirst();

    expect(seen).toEqual(['first', 'second', 'first']);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('routes process_hook FlowData to callbacks without adding transcript output', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID });
    let unsubscribe = () => undefined;
    const delivered = new Promise<AgentHookData>((resolve) => {
      unsubscribe = process.registerCallback(resolve);
    });
    const data = hookData();
    const flowData = new FlowData(FlowElementTypes.STATUS, JSON.stringify(data), {
      'data-type': 'object',
      kind: 'process_hook',
      t: '2026-08-11T00:00:00.000Z',
    });

    process.handleFlowData(flowData);

    await expect(delivered).resolves.toEqual(data);
    unsubscribe();
    expect(process.flowDataStream.items).toHaveLength(0);
  });

  it('rejects delivery for another process id', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID });

    await expect(process.onHook(hookData('00000000-0000-4000-8000-000000000002'))).rejects.toThrow(
      'does not match process',
    );
  });

  it('rehydrates process folders and replaces hook intent on cached updates', () => {
    const process = new AgenticProcess({
      id: PROCESS_ID,
      process_hook_events: [HookEventType.USER_PROMPT_SUBMIT],
    });
    const folder = {
      path: '/tmp/process/execution/assets',
      ref_type: 'folder' as const,
      read_only: false,
      type_id: 'compute_node-@local',
    };
    const update = {
      exe_folder: { ...folder, path: '/tmp/process/execution' },
      input_folder: { ...folder, path: '/tmp/process/execution/input' },
      output_folder: { ...folder, path: '/tmp/process/execution/output' },
      assets_folder: folder,
      process_hook_events: [],
    };

    (process as unknown as { onEntityUpdate: (data: typeof update) => void }).onEntityUpdate(update);

    expect(process.exe_folder).toBeInstanceOf(FSRef);
    expect(process.input_folder).toBeInstanceOf(FSRef);
    expect(process.output_folder).toBeInstanceOf(FSRef);
    expect(process.assets_folder).toBeInstanceOf(FSRef);
    expect(process.assets_folder?.child('plugin').path).toBe('/tmp/process/execution/assets/plugin');
    expect(process.process_hook_events).toEqual([]);
    expect(update).toEqual({});
  });

  it.each([
    [HookEventType.SESSION_START, { source: 'startup' }],
    [HookEventType.SESSION_END, { reason: 'other' }],
  ] as const)('delivers %s to registered callbacks', async (event, extra) => {
    const process = new AgenticProcess({ id: PROCESS_ID, process_hook_events: [event] });
    const received: AgentHookData[] = [];
    const unsubscribe = process.registerCallback((data) => {
      received.push(data);
    });
    const data: AgentHookData = {
      webhook_type: 'agent_hook',
      agentic_process_id: PROCESS_ID,
      hook_data: { hook_event_name: event, session_id: 's1', ...extra },
    };

    await process.onHook(data);
    unsubscribe();

    expect(received).toEqual([data]);
  });

  it.each([HookEventType.SESSION_START, HookEventType.SESSION_END] as const)(
    'setHook/removeHook pass %s through to the process action',
    async (event) => {
      const callAction = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ changed: true });
      const process = new AgenticProcess({ id: PROCESS_ID });

      expect(await process.setHook(event)).toBe(true);
      expect(await process.removeHook(event)).toBe(true);

      expect(callAction.mock.calls.map((call) => [call[0].name, call[0].bodyParameters])).toEqual([
        ['set-hook', { event }],
        ['remove-hook', { event }],
      ]);
    },
  );

  it('clears callbacks only after a successful delete', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deleted = new AgenticProcess({ id: PROCESS_ID });
    const failed = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000002' });
    const seen: string[] = [];
    deleted.registerCallback(() => seen.push('deleted'));
    const unsubscribeFailed = failed.registerCallback(() => seen.push('failed'));
    vi.spyOn(dataManager, 'delete').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('delete failed'));

    await deleted.delete();
    await expect(failed.delete()).rejects.toThrow('delete failed');
    await deleted.onHook(hookData(deleted.id));
    await failed.onHook(hookData(failed.id));
    unsubscribeFailed();

    expect(seen).toEqual(['failed']);
  });
});
