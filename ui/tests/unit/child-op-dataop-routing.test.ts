/**
 * child_* data_op frames route by their INVERTED envelope.
 *
 * For create/update/delete, `to_entity` IS the changed entity. For the child ops
 * it is the PARENT — `from_entity` and `data` carry the child. Every consumer of
 * `on_data_op` predates that distinction, so the risk is not that they ignore a
 * child frame but that they mistake it for a frame about the parent:
 *
 *   - the entity store would run `castAndDeepAssign(child)` into the parent's
 *     cache ref, corrupting the conversation with a message's fields;
 *   - the fs-record dispatcher would tell `conversation` subscribers "this
 *     record changed", handing them an unrelated child as the payload.
 *
 * These are the guards for both, plus the wiring that makes the whole thing
 * useful: `from_entity` surviving the emit, and the app bus getting its own
 * tag rather than a silent drop.
 */
import { describe, expect, it, vi } from 'vitest';
import { DataOp, type DataOpType } from '@sdk/websocket';

describe('child_* op vocabulary', () => {
  it('matches the hub wire values exactly', () => {
    // A drift here means a hub frame stops being recognised at all — it would
    // fall through every branch and vanish without error.
    expect(DataOp.CHILD_CREATED).toBe('child_created');
    expect(DataOp.CHILD_UPDATED).toBe('child_updated');
    expect(DataOp.CHILD_DELETED).toBe('child_deleted');
  });

  it('is assignable to DataOpType', () => {
    const ops: DataOpType[] = ['create', 'update', 'delete', 'child_created', 'child_updated', 'child_deleted'];
    expect(ops).toHaveLength(6);
  });
});

describe('app bus tags', () => {
  it('gives child ops their own tag instead of dropping them', async () => {
    const { emitEntityTag } = await import('@sdk/FlowSync/entity.onTag');
    const { EventBus } = await import('@sdk/tags/EventBus');
    const { TypeId } = await import('@sdk/models/TypeId');

    const seen: string[] = [];
    const off = EventBus.on('app.entity.child_created', (e: any) => seen.push(e.tag));
    try {
      emitEntityTag(new TypeId('conversation', '11111111-1111-4111-8111-111111111111'), 'child_created', null);
    } finally {
      off();
    }
    // Previously `OP_TO_TAG[op]` was undefined for child ops and the emit
    // returned early, so nothing on the bus could react to a subtree change.
    expect(seen).toEqual(['app.entity.child_created']);
  });
});

describe('fs-record dispatcher', () => {
  it('ignores child ops rather than treating the parent as the changed record', async () => {
    const { subscribeFsRecord } = await import('@sdk/resource_management/fs_records/data-op-handler');
    const { fsRecordTypeRegistry } = await import('@sdk/resource_management/fs_records/record-type-registry');
    const { ConnectionManager } = await import('@sdk/websocket');

    // `conversation` is the type that makes this reachable in production — a
    // parent-addressed child frame whose type IS an fs record. In a bare unit
    // run nothing has imported the FsRecord subclasses yet, so register it here
    // through the registry's own API rather than skipping the case.
    const recordType = 'conversation';
    if (!fsRecordTypeRegistry.has(recordType)) {
      fsRecordTypeRegistry.register(recordType, class {} as any);
    }
    expect(fsRecordTypeRegistry.has(recordType)).toBe(true);

    const parentId = '11111111-1111-4111-8111-111111111111';
    const handler = vi.fn();
    // subscribeFsRecord() runs ensureAttached(), wiring the module's private
    // handleDataOp to the ConnectionManager — so emitting there drives the REAL
    // dispatch path rather than a test-only entry point.
    const off = subscribeFsRecord(recordType, handler);
    const cm = ConnectionManager.getInstance();
    try {
      // Control: a normal op for this record type DOES reach subscribers.
      cm.emit('on_data_op', `${recordType}-${parentId}`, 'update', { id: parentId });
      expect(handler, 'control: a plain update should dispatch').toHaveBeenCalledTimes(1);

      handler.mockClear();
      cm.emit(
        'on_data_op',
        `${recordType}-${parentId}`,
        'child_created',
        { id: '22222222-2222-4222-8222-222222222222', text: 'a message, not a conversation' },
        `flow_message-22222222-2222-4222-8222-222222222222`,
      );
      expect(handler, 'a child op must not dispatch as a change to the parent record').not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});
