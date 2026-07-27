import { AgenticProcess } from '@sdk';
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
});
