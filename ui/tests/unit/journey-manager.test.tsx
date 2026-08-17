// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { dataManager, EventBus, Journey, JourneyGraph, JourneyJournal, type JourneyStep } from '@sdk';
import { useJourneyManager } from '@src/journey/useJourneyManager';
import type { UseJourneyResult } from '@src/journey/use-journey';

const openDock = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock, highlight: vi.fn() },
    currentDock: null,
  }),
}));

vi.mock('@sdk/react/hooks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useProject: () => ({ project: null }),
}));

const JOURNEY_ID = '5eaa7e57-1111-4222-8333-444455556666';

function makeStep(node_id: string, waitFor?: JourneyStep['waitFor']): JourneyStep {
  return { node_id, name: node_id, status_line: '', present: { dock: { kind: 'root' } }, waitFor };
}

/** Two steps, sitting on `at` (1-based) — the position the URL would give.
 *  Built ONCE per test and held: the real state comes from a loaded graph, so
 *  rebuilding it every render would churn identities the hook memoizes on. */
function makeState(at: number, waitFor?: JourneyStep['waitFor']): UseJourneyResult {
  const steps = [makeStep('s1', waitFor), makeStep('s2')];
  return {
    journey: new Journey({ id: JOURNEY_ID, name: 'Test journey' }),
    journal: new JourneyJournal({ journey_id: JOURNEY_ID, status: 'launched' }),
    graph: new JourneyGraph({ steps }),
    currentStep: steps[at - 1],
    stepNumber: at,
    cursorIndex: at - 1,
    loading: false,
    refresh: () => {},
  };
}

/** The step number the manager navigated to, or null if it never navigated. */
const wentTo = (): number | null => {
  const last = openDock.mock.calls.at(-1)?.[0] as { journeyStep?: number } | undefined;
  return last?.journeyStep ?? null;
};

describe('useJourneyManager — the user is the only mover', () => {
  beforeEach(() => {
    EventBus.clear();
    openDock.mockClear();
    vi.spyOn(Journey.prototype, 'advance').mockResolvedValue(new JourneyJournal({ journey_id: JOURNEY_ID }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('a satisfied condition does NOT advance anything — only a press does', async () => {
    // The store already holds the row this step waits for. Under the old engine
    // that completed the step by itself, in the commit it rendered in.
    vi.spyOn(dataManager, 'query').mockResolvedValue([{ id: 'a1' } as never]);
    const state = makeState(1, [{ entity: { type: 'agent', min: 1 } }]);
    renderHook(() => useJourneyManager(state));

    await new Promise((r) => setTimeout(r, 20));
    expect(openDock).not.toHaveBeenCalled();
  });

  it('Next on an ungated step lands on the next step immediately', async () => {
    const state = makeState(1);
    const { result } = renderHook(() => useJourneyManager(state));

    act(() => result.current.next());

    await waitFor(() => expect(wentTo()).toBe(2));
  });

  it('Next on a gated step waits, then lands when the gate opens — one press', async () => {
    const query = vi.spyOn(dataManager, 'query').mockResolvedValue([]);
    const state = makeState(1, [{ entity: { type: 'agent', min: 1 } }]);
    const { result } = renderHook(() => useJourneyManager(state));
    await waitFor(() => expect(query).toHaveBeenCalled());

    act(() => result.current.next());
    expect(result.current.waiting).toBe(true);
    expect(openDock).not.toHaveBeenCalled();

    // The store now says yes; the press that already happened completes itself.
    query.mockResolvedValue([{ id: 'a1' } as never]);
    EventBus.emit('app.entity.created', 'agent:123', {});

    await waitFor(() => expect(wentTo()).toBe(2));
  });

  it('a step returned to with Back can still move on', async () => {
    // The landing guard is per VISIT, not per step number. Keyed by number and
    // never reset, a step you came back to could never land again — Next would
    // silently do nothing for the rest of the journey.
    const state = makeState(1);
    const { result } = renderHook(() => useJourneyManager(state));

    act(() => result.current.next());
    await waitFor(() => expect(wentTo()).toBe(2));

    // Back to step 1 (the URL drives position, so the same state stands in for
    // being on step 1 again), then forward once more.
    openDock.mockClear();
    const again = renderHook(() => useJourneyManager(makeState(1)));
    act(() => again.result.current.next());
    await waitFor(() => expect(wentTo()).toBe(2));
  });

  it('Back loads the previous step, and stops at the first', () => {
    const atSecond = makeState(2);
    const { result: second } = renderHook(() => useJourneyManager(atSecond));
    expect(second.current.canGoBack).toBe(true);
    act(() => second.current.back());
    expect(wentTo()).toBe(1);

    openDock.mockClear();
    const atFirst = makeState(1);
    const { result: first } = renderHook(() => useJourneyManager(atFirst));
    expect(first.current.canGoBack).toBe(false);
    act(() => first.current.back());
    expect(openDock).not.toHaveBeenCalled();
  });
});
