/**
 * Regression test for the DataManager WebSocket UPDATE race condition.
 *
 * Bug: When a WebSocket DataOp UPDATE arrives while an entity GET is in-flight
 * (ref.entity === null, status === FETCHING), the update was silently dropped.
 * This caused ProcessTerminal to render with stale entity data (pty_session_id=null)
 * after "Start Claude" clicked, producing a permanently blank content area.
 *
 * Fix: Buffer the UPDATE in ref.pendingUpdate. When fetchByTypeId completes,
 * flush the buffered update so the final entity reflects the WebSocket payload.
 *
 * File: ts_sdk/src/FlowSync/store.ts
 *   - onDataOp UPDATE case: store in ref.pendingUpdate instead of dropping
 *   - fetchByTypeId: apply ref.pendingUpdate after GET resolves
 */

import { dataManager, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Use a simple entity type that's guaranteed to be registered: 'agent'
const ENTITY_TYPE = 'agentic_process';
const ENTITY_ID = '550e8400-e29b-41d4-a716-446655440001';
const PTY_SESSION_ID = 'aaaabbbb-cccc-4ddd-eeee-ffffffffffff';

// Stale GET response: captured before startPty() saved pty_session_id
const staleEntityJson = {
  type: ENTITY_TYPE,
  id: ENTITY_ID,
  pty_session_id: null,
};

// WebSocket UPDATE payload: entity after startPty() completed on backend
const updatedEntityJson = {
  type: ENTITY_TYPE,
  id: ENTITY_ID,
  pty_session_id: PTY_SESSION_ID,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRef(typeId: TypeId) {
  return (dataManager as any).getRef(typeId);
}

function fireDataOpUpdate(typeId: TypeId, data: object) {
  (dataManager as any).onDataOp(typeId.toString(), 'update', data);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DataManager: WebSocket UPDATE race during entity GET', () => {
  const typeId = new TypeId(ENTITY_TYPE, ENTITY_ID);
  let resolveGet: (value: unknown) => void;

  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();

    // Defer the HTTP GET so we control exactly when it resolves.
    // apiClient.get already returns unwrapped data (response.data.data via interceptor).
    const deferredGet = new Promise((resolve) => {
      resolveGet = resolve;
    });
    vi.spyOn(apiClient, 'get').mockReturnValue(deferredGet as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buffers the UPDATE while GET is in-flight instead of dropping it', async () => {
    // Start fetch — ref is created with entity=null, status=FETCHING
    const fetchPromise = dataManager.getByTypeId(typeId);

    // WebSocket UPDATE arrives before GET resolves
    fireDataOpUpdate(typeId, updatedEntityJson);

    const ref = getRef(typeId);

    // BUG (unfixed): ref.pendingUpdate would be null — update silently dropped
    // FIX: update is buffered in ref.pendingUpdate
    expect(ref.pendingUpdate).not.toBeNull();
    expect(ref.pendingUpdate.pty_session_id).toBe(PTY_SESSION_ID);

    // Entity is still null — fetch hasn't completed
    expect(ref.entity).toBeNull();

    // Resolve the GET so the test cleans up
    resolveGet(staleEntityJson);
    await fetchPromise;
  });

  it('applies the buffered UPDATE on fetch completion — entity reflects WebSocket data, not stale GET', async () => {
    // Start fetch
    const fetchPromise = dataManager.getByTypeId(typeId);

    // WebSocket UPDATE arrives while in-flight
    fireDataOpUpdate(typeId, updatedEntityJson);

    // Resolve GET with stale snapshot (no pty_session_id)
    resolveGet(staleEntityJson);
    const entity = await fetchPromise;

    // BUG (unfixed): entity.pty_session_id would be null — stale GET wins
    // FIX: entity.pty_session_id is PTY_SESSION_ID — buffered UPDATE applied after GET
    expect(entity).not.toBeNull();
    expect((entity as any).pty_session_id).toBe(PTY_SESSION_ID);
  });

  it('clears pendingUpdate after flushing so it is not applied twice', async () => {
    const fetchPromise = dataManager.getByTypeId(typeId);
    fireDataOpUpdate(typeId, updatedEntityJson);

    resolveGet(staleEntityJson);
    await fetchPromise;

    const ref = getRef(typeId);
    expect(ref.pendingUpdate).toBeNull();
  });

  it('does not buffer when entity is already in cache — UPDATE applied immediately', async () => {
    // Simulate entity already cached (normal path, no race)
    const ref = getRef(typeId);
    ref.entity = { type: ENTITY_TYPE, id: ENTITY_ID, pty_session_id: null };
    ref.status = 'READY';

    // UPDATE arrives — entity is non-null, should apply directly
    fireDataOpUpdate(typeId, updatedEntityJson);

    expect(ref.pendingUpdate).toBeNull(); // no buffering
    expect(ref.entity?.pty_session_id).toBe(PTY_SESSION_ID); // applied inline
  });
});
