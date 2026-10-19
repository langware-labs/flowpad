import { AgenticProcess, DataManager, WorkerStatus } from '@sdk';
import { getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { describe, expect, it } from 'vitest';

/**
 * A spawned-but-never-prompted PTY worker writes no transcript, so the backend
 * sends `worker_status: null` — its "spawned and idle" signal, not a boot state
 * (`_discover_status_from_transcript` only reports INITIALIZING while the
 * lifecycle is STARTING, never while RUNNING).
 *
 * These two fields are the whole reproduction; the observed wire body carried
 * `busy: false` / `ready_for_input: true` alongside them, but neither is read
 * by the code under test.
 */
const IDLE_AT_PROMPT_WIRE_ENTITY = { status: 'running', worker_status: null } as const;

describe('null worker_status on a RUNNING process', () => {
  it('stays undefined instead of being substituted', () => {
    expect(new AgenticProcess(IDLE_AT_PROMPT_WIRE_ENTITY).workerStatus).toBeUndefined();
  });

  it('reads as Idle, not a permanent Initializing spinner', () => {
    const process = new AgenticProcess(IDLE_AT_PROMPT_WIRE_ENTITY);

    // The label the chat composer renders next to the send button.
    expect(getStatusLabel(process)).toBe('Idle');
  });

  it('normalizes running → null to undefined and emits one transition', () => {
    const process = new AgenticProcess({ worker_status: WorkerStatus.WORKING });
    const transitions: unknown[] = [];
    process.on('state_change', (event) => {
      if (event.field === 'workerStatus') transitions.push(event);
    });

    (process as any).onEntityUpdate({ worker_status: null });

    expect(process.workerStatus).toBeUndefined();
    expect(transitions).toEqual([
      {
        field: 'workerStatus',
        oldValue: WorkerStatus.WORKING,
        newValue: undefined,
      },
    ]);
  });

  it('preserves the current status and emits nothing when worker_status is omitted', () => {
    const process = new AgenticProcess({ worker_status: WorkerStatus.WORKING });
    const transitions: unknown[] = [];
    process.on('state_change', (event) => {
      if (event.field === 'workerStatus') transitions.push(event);
    });

    (process as any).onEntityUpdate({ status: 'running' });

    expect(process.workerStatus).toBe(WorkerStatus.WORKING);
    expect(transitions).toEqual([]);
  });

  it('does not emit a duplicate transition for repeated null', () => {
    const process = new AgenticProcess({ worker_status: WorkerStatus.WORKING });
    const transitions: unknown[] = [];
    process.on('state_change', (event) => {
      if (event.field === 'workerStatus') transitions.push(event);
    });

    (process as any).onEntityUpdate({ worker_status: null });
    (process as any).onEntityUpdate({ worker_status: null });

    expect(process.workerStatus).toBeUndefined();
    expect(transitions).toHaveLength(1);
  });

  it('clears both normalized and raw status through the cache update pipeline', () => {
    const manager = new DataManager<AgenticProcess>();
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const process = manager.updateEntityFromJson<AgenticProcess>({
      type: AgenticProcess.type,
      id,
      status: 'running',
      busy: false,
      worker_status: WorkerStatus.WORKING,
    });
    const transitions: unknown[] = [];
    process.on('state_change', (event) => {
      if (event.field === 'workerStatus') transitions.push(event);
    });

    const updated = manager.updateEntityFromJson<AgenticProcess>({
      type: AgenticProcess.type,
      id,
      worker_status: null,
    });
    manager.updateEntityFromJson<AgenticProcess>({
      type: AgenticProcess.type,
      id,
      worker_status: null,
    });

    expect(updated).toBe(process);
    expect(updated.workerStatus).toBeUndefined();
    expect((updated as any).worker_status).toBeNull();
    expect(getStatusLabel(updated)).toBe('Idle');
    expect(transitions).toEqual([
      {
        field: 'workerStatus',
        oldValue: WorkerStatus.WORKING,
        newValue: undefined,
      },
    ]);
  });
});
