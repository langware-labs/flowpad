/**
 * Regression test for the DataManager WebSocket CREATE race during entity GET.
 *
 * Bug: The 'create' DataOp branch only deferred while a save was in flight
 * (existingRef.saveInFlight). When a 'create' arrived while a GET was in-flight
 * (ref.status === FETCHING, entity still null), it was applied immediately —
 * then fetchByTypeId overwrote ref.entity with the (older) GET body, erasing the
 * create. The 'update' branch already buffered in this case; 'create' did not.
 *
 * Fix: give 'create' the same in-flight guard as 'update' — buffer via
 * bufferPendingUpdate when existingRef.saveInFlight OR status === FETCHING, so
 * fetchByTypeId flushes it via applyPendingUpdate after the GET resolves and the
 * create's fields win over the stale GET body.
 *
 * File: ts_sdk/src/FlowSync/store.ts — onDataOp 'create' case.
 */

import { dataManager, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENTITY_TYPE = 'agentic_process';
const ENTITY_ID = '550e8400-e29b-41d4-a716-4466554400c1';
const PTY_SESSION_ID = 'aaaabbbb-cccc-4ddd-eeee-ffffffffcccc';

// Stale GET response: captured before the create landed on the backend.
const staleEntityJson = {
  type: ENTITY_TYPE,
  id: ENTITY_ID,
  session_id: null,
  pty_session_id: null,
};

// WebSocket CREATE payload: entity as it exists after creation on the backend.
const createdEntityJson = {
  type: ENTITY_TYPE,
  id: ENTITY_ID,
  session_id: 'sess-created',
  pty_session_id: PTY_SESSION_ID,
};

function getRef(typeId: TypeId) {
  return (dataManager as any).getRef(typeId);
}

function fireDataOp(typeId: TypeId, op: 'create' | 'update' | 'delete', data: object) {
  (dataManager as any).onDataOp(typeId.toString(), op, data);
}

describe('DataManager: WebSocket CREATE race during entity GET', () => {
  const typeId = new TypeId(ENTITY_TYPE, ENTITY_ID);
  let resolveGet: (value: unknown) => void;

  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();

    const deferredGet = new Promise((resolve) => {
      resolveGet = resolve;
    });
    vi.spyOn(apiClient, 'get').mockReturnValue(deferredGet as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buffers the CREATE while GET is in-flight instead of applying it', async () => {
    // Start fetch — ref is created with entity=null, status=FETCHING.
    const fetchPromise = dataManager.getByTypeId(typeId);

    // WebSocket CREATE arrives before GET resolves.
    fireDataOp(typeId, 'create', createdEntityJson);

    const ref = getRef(typeId);

    // BUG (unfixed): create applied immediately, pendingUpdate stays null.
    // FIX: create buffered in ref.pendingUpdate; entity still null.
    expect(ref.pendingUpdate).not.toBeNull();
    expect(ref.pendingUpdate.pty_session_id).toBe(PTY_SESSION_ID);
    expect(ref.entity).toBeNull();

    resolveGet(staleEntityJson);
    await fetchPromise;
  });

  it('applies the buffered CREATE on fetch completion — create fields win over the stale GET body', async () => {
    const fetchPromise = dataManager.getByTypeId(typeId);

    fireDataOp(typeId, 'create', createdEntityJson);

    // Resolve GET with the stale snapshot (no session/pty ids).
    resolveGet(staleEntityJson);
    const entity = await fetchPromise;

    // BUG (unfixed): stale GET body wins — session_id/pty_session_id null.
    // FIX: buffered CREATE applied after GET — its fields win.
    expect(entity).not.toBeNull();
    expect((entity as any).session_id).toBe('sess-created');
    expect((entity as any).pty_session_id).toBe(PTY_SESSION_ID);
  });

  it('clears pendingUpdate after flushing so the CREATE is not applied twice', async () => {
    const fetchPromise = dataManager.getByTypeId(typeId);
    fireDataOp(typeId, 'create', createdEntityJson);

    resolveGet(staleEntityJson);
    await fetchPromise;

    const ref = getRef(typeId);
    expect(ref.pendingUpdate).toBeNull();
  });
});
