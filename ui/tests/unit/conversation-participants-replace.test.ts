/**
 * Conversation roster updates must REPLACE the cached ``members`` array, never
 * index-merge it.
 *
 * Bug class: ``DataManager.deepAssign`` recurses into arrays and merges them
 * by index without truncating, so a membership shrink ([A,B] + wire [B] →
 * [B,B]) left the departed member at the tail and cross-merged unrelated
 * entries' fields. The fix is the ``Conversation.onEntityUpdate`` hook
 * (ts_sdk/src/entities/conversation.ts) — the same pattern AgenticProcess
 * uses for ``queue`` — which assigns the wire roster wholesale and strips it
 * from the payload before deepAssign runs.
 *
 * The roster field is ``members`` (generic, on the Entity base). The local
 * backend serializes it as ``members``; the hub conversation fanout uses the
 * ``participants`` wire key — the hook accepts either and lands it on
 * ``members`` (see the wire-adapter case below).
 */

import { dataManager, TypeId } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENTITY_TYPE = 'conversation';
const ENTITY_ID = '550e8400-e29b-41d4-a716-446655440002';

const USER_A = { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Alice', role: 'owner' };
const USER_B = { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Bob', role: 'member' };

function fireDataOpUpdate(typeId: TypeId, data: object) {
  (dataManager as any).onDataOp(typeId.toString(), 'update', data);
}

function seedCachedConversation(typeId: TypeId, members: object[]) {
  const ref = (dataManager as any).getRef(typeId);
  ref.entity = new Conversation({
    id: ENTITY_ID,
    title: 'roster test',
    members: members as any,
  });
  ref.status = 'READY';
  return ref;
}

describe('Conversation roster: wire roster replaces cached roster', () => {
  const typeId = new TypeId(ENTITY_TYPE, ENTITY_ID);

  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a 2→1 shrink drops the departed member (no stale tail)', () => {
    const ref = seedCachedConversation(typeId, [USER_A, USER_B]);

    fireDataOpUpdate(typeId, {
      type: ENTITY_TYPE,
      id: ENTITY_ID,
      members: [{ ...USER_B }],
    });

    expect(ref.entity.members).toHaveLength(1);
    expect(ref.entity.members[0].user_id).toBe(USER_B.user_id);
  });

  it('entries are fully replaced — no key bleed from the old entry at the same index', () => {
    // Old index 0 is Alice(owner); wire index 0 is Bob WITHOUT a role key.
    // Index-merge would produce Bob-with-Alice's-role; replace must not.
    const ref = seedCachedConversation(typeId, [USER_A, USER_B]);

    fireDataOpUpdate(typeId, {
      type: ENTITY_TYPE,
      id: ENTITY_ID,
      members: [{ user_id: USER_B.user_id, name: USER_B.name }],
    });

    expect(ref.entity.members).toHaveLength(1);
    expect(ref.entity.members[0].role).toBeUndefined();
  });

  it('a grow (re-invite) lands both entries', () => {
    const ref = seedCachedConversation(typeId, [USER_A]);

    fireDataOpUpdate(typeId, {
      type: ENTITY_TYPE,
      id: ENTITY_ID,
      members: [{ ...USER_A }, { ...USER_B }],
    });

    expect(ref.entity.members).toHaveLength(2);
    expect(ref.entity.members.map((p: any) => p.user_id)).toEqual([USER_A.user_id, USER_B.user_id]);
  });

  it('an update without a roster leaves the cached roster untouched', () => {
    const ref = seedCachedConversation(typeId, [USER_A, USER_B]);

    fireDataOpUpdate(typeId, {
      type: ENTITY_TYPE,
      id: ENTITY_ID,
      title: 'renamed',
    });

    expect(ref.entity.title).toBe('renamed');
    expect(ref.entity.members).toHaveLength(2);
  });

  it('other scalar fields in the same frame still merge normally', () => {
    const ref = seedCachedConversation(typeId, [USER_A, USER_B]);

    fireDataOpUpdate(typeId, {
      type: ENTITY_TYPE,
      id: ENTITY_ID,
      title: 'after-leave',
      members: [{ ...USER_A }],
    });

    expect(ref.entity.title).toBe('after-leave');
    expect(ref.entity.members).toHaveLength(1);
    expect(ref.entity.members[0].user_id).toBe(USER_A.user_id);
  });

  it('wire adapter: a legacy ``participants`` frame key lands on ``members``', () => {
    // The hub conversation fanout uses ``participants``; the hook must accept it
    // and replace ``members`` (not create a stale ``participants`` field).
    const ref = seedCachedConversation(typeId, [USER_A, USER_B]);

    fireDataOpUpdate(typeId, {
      type: ENTITY_TYPE,
      id: ENTITY_ID,
      participants: [{ ...USER_B }],
    });

    expect(ref.entity.members).toHaveLength(1);
    expect(ref.entity.members[0].user_id).toBe(USER_B.user_id);
    expect(ref.entity.participants).toBeUndefined();
  });
});
