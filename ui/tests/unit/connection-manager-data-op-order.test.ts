import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionManager } from '@sdk/websocket';

const ENTITY_ID = '00000000-0000-4000-8000-000000000001';
const TO_ENTITY = `agentic_process-${ENTITY_ID}`;

function frame(instanceId: number, ptyMode: boolean) {
  return {
    message_type: 'data_op_msg',
    message_id: `message-${instanceId}`,
    instance_id: instanceId,
    to_entity: TO_ENTITY,
    op: 'update',
    data: { id: ENTITY_ID, type: 'agentic_process', pty_mode: ptyMode },
  } as const;
}

const managers: ConnectionManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

describe('ConnectionManager data-op ordering', () => {
  it('rejects an older frame for the same entity on one socket', () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    const accepted: boolean[] = [];
    manager.on('on_data_op', (_typeId, _op, data) => accepted.push(data.pty_mode));

    manager.onDataOpMessage(frame(42, false) as never);
    manager.onDataOpMessage(frame(41, true) as never);

    expect(accepted).toEqual([false]);
  });

  it('resets sequence ownership when a new socket opens', () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    const accepted: boolean[] = [];
    manager.on('on_data_op', (_typeId, _op, data) => accepted.push(data.pty_mode));

    manager.onDataOpMessage(frame(42, false) as never);
    manager.onOpen(new Event('open'));
    manager.onDataOpMessage(frame(1, true) as never);

    expect(accepted).toEqual([false, true]);
  });
});
