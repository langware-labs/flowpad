import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Initialize shared test state before any mocks are set up.
// vi.hoisted runs before vi.mock factories.
const __atShared = vi.hoisted(() => ({
  watchCallbacks: new Map<string, (entities: any[]) => void>(),
  shellSave: vi.fn(async () => {}),
  shellOpen: vi.fn(async () => {}),
  procSave: vi.fn(async () => {}),
  shellCreate: vi.fn(() => ({
    id: 'new-shell-id',
    save: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
  })),
}));

// Mock @sdk/react/hooks with a minimal useEntitiesQuery backed by shared watchCallbacks
vi.mock('@sdk/react/hooks', () => {
  const react = require('react');
  function useEntitiesQuery(request: any) {
    const stateRef = react.useRef({ data: [] as any[], isLoading: true });
    const subscribe = react.useCallback(
      (cb: () => void) => {
        // Register a callback that the test can fire to deliver data
        __atShared.watchCallbacks.set(request.name, (entities: any[]) => {
          stateRef.current = { data: [...entities], isLoading: false };
          cb();
        });
        return () => {
          __atShared.watchCallbacks.delete(request.name);
        };
      },
      [request.type, request.name],
    );
    const getSnapshot = react.useCallback(() => stateRef.current, []);
    return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  return { useEntitiesQuery };
});

import { useActiveTerminals } from '@src/hooks/useActiveTerminals';

// Access shared test state
function shared() {
  return __atShared as {
    watchCallbacks: Map<string, (entities: any[]) => void>;
    shellSave: ReturnType<typeof vi.fn>;
    shellOpen: ReturnType<typeof vi.fn>;
    procSave: ReturnType<typeof vi.fn>;
    shellCreate: ReturnType<typeof vi.fn>;
  };
}

function makeShell(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'shell-1',
    type: 'shell',
    status: overrides.status ?? 'running',
    tab_order: overrides.tab_order ?? 0,
    name: overrides.name ?? null,
    pty_pid: overrides.pty_pid ?? overrides.id ?? 'shell-1',
    ...overrides,
  };
}

function makeProcess(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'proc-1',
    type: 'agentic_process',
    status: overrides.status ?? 'live',
    shell_id: overrides.shell_id ?? null,
    pty_pid: overrides.pty_pid ?? null,
    save: shared().procSave,
    ...overrides,
  };
}

describe('useActiveTerminals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared().watchCallbacks.clear();
  });

  it('returns 3 tabs in correct order with claude tab for linked process', async () => {
    const { result } = renderHook(() => useActiveTerminals());

    // Deliver shell data
    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:shells')?.([
        makeShell({ id: 'sh-0', tab_order: 0, name: 'Terminal 1' }),
        makeShell({ id: 'sh-1', tab_order: 1, name: 'Claude Session' }),
        makeShell({ id: 'sh-2', tab_order: 2, name: 'Terminal 3' }),
      ]);
    });

    // Deliver process data - linked to sh-1
    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:processes')?.([
        makeProcess({ id: 'proc-1', shell_id: 'sh-1', status: 'running' }),
      ]);
    });

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.tabs[0].type).toBe('plain');
    expect(result.current.tabs[0].shellId).toBe('sh-0');
    expect(result.current.tabs[1].type).toBe('claude');
    expect(result.current.tabs[1].shellId).toBe('sh-1');
    expect(result.current.tabs[1].agenticProcess).toBeDefined();
    expect(result.current.tabs[2].type).toBe('plain');
    expect(result.current.tabs[2].shellId).toBe('sh-2');
  });

  it('ignores orphan processes (no shell_id) without creating shells', async () => {
    const { result } = renderHook(() => useActiveTerminals());

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:shells')?.([
        makeShell({ id: 'sh-existing', tab_order: 0 }),
      ]);
    });

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:processes')?.([
        makeProcess({ id: 'proc-orphan', shell_id: null, status: 'running' }),
      ]);
    });

    // Only the existing shell should appear — orphan process is ignored
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].shellId).toBe('sh-existing');
    expect(shared().shellCreate).not.toHaveBeenCalled();
  });

  it('shows all shells from DB (closed ones appear as disabled tabs)', async () => {
    const { result } = renderHook(() => useActiveTerminals());

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:shells')?.([
        makeShell({ id: 'sh-active', tab_order: 0, status: 'running' }),
        makeShell({ id: 'sh-closed', tab_order: 1, status: 'closed' }),
      ]);
    });

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:processes')?.([]);
    });

    // Both shells appear — closed shells are shown as disabled tabs until the entity is deleted
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].shellId).toBe('sh-active');
    expect(result.current.tabs[0].isDisabled).toBe(false);
    expect(result.current.tabs[1].shellId).toBe('sh-closed');
    expect(result.current.tabs[1].isDisabled).toBe(true);
  });

  it('excludes sidecar shells from the top-level tab strip', async () => {
    const { result } = renderHook(() => useActiveTerminals());

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:shells')?.([
        makeShell({ id: 'sh-main', tab_order: 0, name: 'Claude Session' }),
        makeShell({ id: 'sh-sidecar', tab_order: 1, name: null }),
      ]);
    });

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:processes')?.([
        makeProcess({ id: 'proc-1', shell_id: 'sh-main', sidecar_shell_id: 'sh-sidecar', status: 'running' }),
      ]);
    });

    // Only the main shell should appear — the sidecar shell is managed inside InteractiveTerminal
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].shellId).toBe('sh-main');
    expect(result.current.tabs[0].type).toBe('claude');
  });

  it('preserves tab order across re-renders', async () => {
    const { result } = renderHook(() => useActiveTerminals());

    const shellData = [
      makeShell({ id: 'sh-c', tab_order: 2 }),
      makeShell({ id: 'sh-a', tab_order: 0 }),
      makeShell({ id: 'sh-b', tab_order: 1 }),
    ];

    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:shells')?.(shellData);
    });
    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:processes')?.([]);
    });

    expect(result.current.tabs.map((t) => t.shellId)).toEqual(['sh-a', 'sh-b', 'sh-c']);

    // Re-deliver same data
    await act(async () => {
      shared().watchCallbacks.get('useActiveTerminals:shells')?.(shellData);
    });

    expect(result.current.tabs.map((t) => t.shellId)).toEqual(['sh-a', 'sh-b', 'sh-c']);
  });
});
