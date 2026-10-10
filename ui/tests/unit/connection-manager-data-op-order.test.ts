import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionManager, DATA_OP_REORDER_WINDOW } from '@sdk/websocket';

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

const entityId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** A data-op for its own entity — what a stream of newly created rows looks like. */
function frameFor(index: number, instanceId: number, op: 'create' | 'update' | 'delete' = 'create') {
  return {
    message_type: 'data_op_msg',
    message_id: `message-${instanceId}`,
    instance_id: instanceId,
    to_entity: `agentic_process-${entityId(index)}`,
    op,
    data: { id: entityId(index), type: 'agentic_process', index },
  } as const;
}

const rememberedEntities = (manager: ConnectionManager): number =>
  (manager as unknown as { lastDataOpInstanceByEntity: Map<string, number> }).lastDataOpInstanceByEntity.size;

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

  it('remembers only the entities inside the reorder window, however many it has seen', () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    let delivered = 0;
    manager.on('on_data_op', () => delivered++);
    const entities = DATA_OP_REORDER_WINDOW * 3;

    for (let i = 1; i <= entities; i++) manager.onDataOpMessage(frameFor(i, i) as never);

    expect(delivered).toBe(entities);
    expect(rememberedEntities(manager)).toBe(DATA_OP_REORDER_WINDOW + 1);
  });

  it('keeps one entry for an entity however many frames it gets', () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    for (let i = 1; i <= DATA_OP_REORDER_WINDOW * 2; i++) manager.onDataOpMessage(frame(i, false) as never);

    expect(rememberedEntities(manager)).toBe(1);
  });

  it('still orders frames inside the window after traffic has pushed older entities out', () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    const traffic = DATA_OP_REORDER_WINDOW * 2;
    for (let i = 1; i <= traffic; i++) manager.onDataOpMessage(frameFor(i, i) as never);
    const accepted: string[] = [];
    manager.on('on_data_op', (_typeId, op, data) => accepted.push(`${data.index}:${op}`));

    manager.onDataOpMessage(frameFor(1, traffic + 3, 'delete') as never);
    manager.onDataOpMessage(frameFor(1, traffic + 2, 'update') as never); // older frame for the same entity
    manager.onDataOpMessage(frameFor(1, traffic + 3, 'delete') as never); // the same frame again
    manager.onDataOpMessage(frameFor(2, traffic + 1, 'update') as never); // older, but another entity

    expect(accepted).toEqual(['1:delete', '2:update']);
  });

  it('starts the window over when a new socket opens', () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    const traffic = DATA_OP_REORDER_WINDOW * 2;
    for (let i = 1; i <= traffic; i++) manager.onDataOpMessage(frameFor(i, i) as never);

    manager.onOpen(new Event('open'));
    expect(rememberedEntities(manager)).toBe(0);

    // The backend counter restarted: low sequences are current again, and they
    // must be remembered rather than measured against the previous socket's high mark.
    manager.onDataOpMessage(frameFor(1, 2) as never);
    manager.onDataOpMessage(frameFor(2, 3) as never);
    const accepted: number[] = [];
    manager.on('on_data_op', (_typeId, _op, data) => accepted.push(data.index));
    manager.onDataOpMessage(frameFor(1, 1) as never);

    expect(accepted).toEqual([]);
    expect(rememberedEntities(manager)).toBe(2);
  });
});
