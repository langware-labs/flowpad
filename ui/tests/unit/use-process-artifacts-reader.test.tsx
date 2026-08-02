/**
 * `useProcessArtifacts` is a READER of `proc.artifacts`, not a query.
 *
 * The thing worth pinning is ORDER. The subscription must be live before the
 * REST GET is issued, because an event landing in a fetch-then-subscribe gap is
 * lost silently — no error, no retry, just a list that is permanently one row
 * short. So: no watched entity query at all, subscribe first, and re-render
 * when a delta lands.
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, targetOf, type FlowEvent } from '@sdk/tags/EventBus';

const PROC_ID = 'dd682350-c185-52c9-a92b-d0667141b069';

/** Records the interleaving of subscribe / fetch, which is the whole point. */
const trace = vi.hoisted(() => [] as string[]);

vi.mock('@sdk/react/hooks', async (orig) => {
  const actual = await orig<typeof import('@sdk/react/hooks')>();
  return {
    ...actual,
    useEntitiesQuery: () => {
      trace.push('query');
      return { data: [], isLoading: false, error: null, refetch: vi.fn() };
    },
    useOnTag: (pattern: string, handler: never, filters?: never) => {
      trace.push(`subscribe:${pattern}`);
      return actual.useOnTag(pattern, handler, filters);
    },
  };
});

import { useProcessArtifacts } from '@src/hooks/use-process-artifacts';

const artifactRow = (id: string, name: string) => ({
  id,
  type: 'artifact',
  name,
  kind: 'content.file',
  asset_ref: `/repo/${name}`,
  generated_by: `agentic_process-${PROC_ID}`,
  created_date: '2026-08-01T10:00:00Z',
});

const ID_A = '9c4d0e11-0000-4000-8000-0000000000a1';
const ID_B = '9c4d0e11-0000-4000-8000-0000000000b2';

/** A stand-in for the process: only what the hook is allowed to touch. */
function fakeProcess(rows: Array<ReturnType<typeof artifactRow>> = []) {
  const state = {
    id: PROC_ID,
    artifacts: [] as Array<Record<string, unknown>>,
    loadArtifacts: vi.fn(() => {
      trace.push('fetch');
      state.artifacts = rows.map((r) => ({ ...r }));
      return Promise.resolve(state.artifacts);
    }),
    applyArtifactEvent: vi.fn((event: FlowEvent) => {
      state.artifacts = [...state.artifacts, { ...event.data, id: event.data.artifact_id }];
      return true;
    }),
  };
  return state;
}

const emitCreated = (id: string, name: string) =>
  EventBus.emit(
    'artifact.created',
    targetOf('artifact', id),
    { artifact_id: id, name, generated_by: `agentic_process-${PROC_ID}` },
    { origin: 'local_server', scope: [targetOf('agentic_process', PROC_ID)] },
  );

describe('useProcessArtifacts', () => {
  beforeEach(() => {
    trace.length = 0;
  });

  it('subscribes to the artifact lane BEFORE issuing the fetch', async () => {
    const proc = fakeProcess([artifactRow(ID_A, 'a.md')]);

    renderHook(() => useProcessArtifacts(proc as never));
    await waitFor(() => expect(proc.loadArtifacts).toHaveBeenCalled());

    // Re-renders re-record the subscribe, so compare FIRST occurrences.
    expect(trace[0]).toBe('subscribe:artifact.*');
    expect(trace.indexOf('fetch')).toBeGreaterThan(trace.indexOf('subscribe:artifact.*'));
  });

  it('runs no watched entity query — the process is the only source', async () => {
    const proc = fakeProcess([artifactRow(ID_A, 'a.md')]);

    renderHook(() => useProcessArtifacts(proc as never));
    await waitFor(() => expect(proc.loadArtifacts).toHaveBeenCalled());

    expect(trace).not.toContain('query');
  });

  it('exposes the process property, and re-renders when a delta lands', async () => {
    const proc = fakeProcess([artifactRow(ID_A, 'a.md')]);
    const { result } = renderHook(() => useProcessArtifacts(proc as never));

    await waitFor(() => expect(result.current.data.map((a) => a.name)).toEqual(['a.md']));

    emitCreated(ID_B, 'b.md');

    await waitFor(() => expect(result.current.data.map((a) => a.name)).toEqual(['a.md', 'b.md']));
    expect(proc.applyArtifactEvent).toHaveBeenCalledOnce();
  });

  it('unsubscribes on unmount — a later event must not touch a dead process', async () => {
    const proc = fakeProcess();
    const { unmount } = renderHook(() => useProcessArtifacts(proc as never));
    await waitFor(() => expect(proc.loadArtifacts).toHaveBeenCalled());

    unmount();
    emitCreated(ID_B, 'b.md');

    expect(proc.applyArtifactEvent).not.toHaveBeenCalled();
  });

  it('is inert with no process — empty, not unscoped', () => {
    const { result } = renderHook(() => useProcessArtifacts(null));

    expect(result.current.data).toEqual([]);
    expect(result.current.latest).toBeNull();
    expect(trace).not.toContain('fetch');
    expect(trace).not.toContain('query');
  });

  it('surfaces a failed load as `error` rather than throwing', async () => {
    const proc = fakeProcess();
    proc.loadArtifacts = vi.fn(() => Promise.reject(new Error('backend down')));

    const { result } = renderHook(() => useProcessArtifacts(proc as never));

    await waitFor(() => expect(result.current.error?.message).toBe('backend down'));
    expect(result.current.data).toEqual([]);
  });

  it('does not render an error boundary when the load rejects', async () => {
    const proc = fakeProcess();
    proc.loadArtifacts = vi.fn(() => Promise.reject(new Error('backend down')));
    const Probe = () => {
      const { data } = useProcessArtifacts(proc as never);
      return <div data-testid="count">{data.length}</div>;
    };

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'));
  });
});
