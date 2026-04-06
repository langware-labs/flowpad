/**
 * FLOWPAD-1645: Switching session tabs must update the displayed content.
 *
 * useEntityData subscribes to a process's flowDataStream by TypeId.
 * When the active TypeId changes (tab switch), the hook must:
 *   1. Clear stale data immediately
 *   2. Re-initialise from the new entity's stream
 *
 * The original bug: if the new entity wasn't in the dataManager cache at the
 * time of the switch, the hook silently returned without clearing the old
 * session's flowData — so Session 2 content stayed on screen even after
 * clicking back to Session 1.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Minimal FlowData stand-in
interface FakeFlowData {
  elementType: string;
  data: string;
}

// Per-entity fake: flowDataStream + event emitter
function makeFakeEntity(items: FakeFlowData[]) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const streamListeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    flowDataStream: {
      items: [...items],
      isComplete: false,
      on(event: string, handler: (...args: any[]) => void) {
        (streamListeners[event] ??= []).push(handler);
      },
      off(event: string, handler: (...args: any[]) => void) {
        streamListeners[event] = (streamListeners[event] ?? []).filter((h) => h !== handler);
      },
      emitStream(event: string, ...args: any[]) {
        for (const h of streamListeners[event] ?? []) h(...args);
      },
    },
    on(event: string, handler: (...args: any[]) => void) {
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
      };
    },
    emit(event: string, ...args: any[]) {
      for (const h of listeners[event] ?? []) h(...args);
    },
    listeners,
  };
}

// Cache map keyed by stringified TypeId
const entityCache = new Map<string, ReturnType<typeof makeFakeEntity>>();

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: {
      ...((actual.dataManager as Record<string, unknown>) ?? {}),
      getByTypeIdFromCache(typeId: { toString(): string }) {
        return entityCache.get(typeId.toString()) ?? null;
      },
    },
  };
});

// ── Import after mocks are wired ────────────────────────────────────────────

import { useEntityData } from '@src/hooks/flow-hooks';
import { TypeId } from '@sdk';

// ── Tests ───────────────────────────────────────────────────────────────────

afterEach(() => {
  entityCache.clear();
});

// Valid UUIDs required by TypeId validation
const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

function tid(id: string) {
  return new TypeId('AgenticProcess', id);
}

describe('useEntityData – session switching (FLOWPAD-1645)', () => {
  it('initialises with flow data from the entity stream', () => {
    const entity = makeFakeEntity([{ elementType: 'chat', data: 'hi' }]);
    entityCache.set(tid(ID1).toString(), entity);

    const { result } = renderHook(() => useEntityData(tid(ID1)));

    expect(result.current.flowData).toHaveLength(1);
    expect((result.current.flowData[0] as FakeFlowData).data).toBe('hi');
  });

  it('clears stale data when switching to an entity not yet in cache', () => {
    // Session 1 is cached and has data
    const entity1 = makeFakeEntity([{ elementType: 'chat', data: 'hi from s1' }]);
    entityCache.set(tid(ID1).toString(), entity1);

    const { result, rerender } = renderHook(({ id }) => useEntityData(tid(id)), {
      initialProps: { id: ID1 },
    });

    // Initially shows session 1 data
    expect(result.current.flowData).toHaveLength(1);

    // Session 2 is NOT in cache (just created, loader hasn't finished)
    rerender({ id: ID2 });

    // Must clear — not keep session 1 data visible
    expect(result.current.flowData).toHaveLength(0);
  });

  it('loads new data when switching to a cached entity', () => {
    const entity1 = makeFakeEntity([{ elementType: 'chat', data: 'hi from s1' }]);
    const entity2 = makeFakeEntity([{ elementType: 'chat', data: 'hello from s2' }]);
    entityCache.set(tid(ID1).toString(), entity1);
    entityCache.set(tid(ID2).toString(), entity2);

    const { result, rerender } = renderHook(({ id }) => useEntityData(tid(id)), {
      initialProps: { id: ID1 },
    });

    expect((result.current.flowData[0] as FakeFlowData).data).toBe('hi from s1');

    rerender({ id: ID2 });

    expect(result.current.flowData).toHaveLength(1);
    expect((result.current.flowData[0] as FakeFlowData).data).toBe('hello from s2');
  });

  it('clears data when typeId becomes null', () => {
    const entity = makeFakeEntity([{ elementType: 'chat', data: 'hi' }]);
    entityCache.set(tid(ID1).toString(), entity);

    const { result, rerender } = renderHook(({ t }) => useEntityData(t), {
      initialProps: { t: tid(ID1) as TypeId | null },
    });

    expect(result.current.flowData).toHaveLength(1);

    rerender({ t: null });

    expect(result.current.flowData).toHaveLength(0);
    expect(result.current.isComplete).toBe(false);
  });

  it('subscribes to new flow_data events after switch', () => {
    const entity1 = makeFakeEntity([{ elementType: 'chat', data: 'msg1' }]);
    const entity2 = makeFakeEntity([]);
    entityCache.set(tid(ID1).toString(), entity1);
    entityCache.set(tid(ID2).toString(), entity2);

    const { result, rerender } = renderHook(({ id }) => useEntityData(tid(id)), {
      initialProps: { id: ID1 },
    });

    // Switch to session 2
    rerender({ id: ID2 });
    expect(result.current.flowData).toHaveLength(0);

    // Simulate new data arriving on session 2's stream
    entity2.flowDataStream.items.push({ elementType: 'chat', data: 'new msg' });
    act(() => {
      entity2.emit('flow_data', entity2.flowDataStream.items[0]);
    });

    expect(result.current.flowData).toHaveLength(1);
    expect((result.current.flowData[0] as FakeFlowData).data).toBe('new msg');
  });

  it('unsubscribes from old entity when switching', () => {
    const entity1 = makeFakeEntity([{ elementType: 'chat', data: 'old' }]);
    const entity2 = makeFakeEntity([]);
    entityCache.set(tid(ID1).toString(), entity1);
    entityCache.set(tid(ID2).toString(), entity2);

    const { result, rerender } = renderHook(({ id }) => useEntityData(tid(id)), {
      initialProps: { id: ID1 },
    });

    // Switch away from session 1
    rerender({ id: ID2 });

    // Old entity fires — should NOT affect current state
    entity1.flowDataStream.items.push({ elementType: 'chat', data: 'late arrival' });
    act(() => {
      entity1.emit('flow_data', { elementType: 'chat', data: 'late arrival' });
    });

    // Should still be empty (session 2's stream)
    expect(result.current.flowData).toHaveLength(0);
  });
});
