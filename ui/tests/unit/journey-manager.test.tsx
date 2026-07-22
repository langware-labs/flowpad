// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { dataManager, EventBus, Journey, JourneyJournal } from '@sdk';
import { useJourneyManager } from '@src/journey/useJourneyManager';
import type { JourneyStep, UseJourneyResult } from '@src/journey/use-journey';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn(), highlight: vi.fn() },
    currentDock: null,
  }),
}));

vi.mock('@sdk/react/hooks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useProject: () => ({ project: null }),
}));

const JOURNEY_ID = '5eaa7e57-1111-4222-8333-444455556666';

function makeStep(awaitSpec: JourneyStep['await']): JourneyStep {
  return { node_id: 's1', name: 'Step 1', status_line: '', present: {}, await: awaitSpec };
}

function makeState(step: JourneyStep): UseJourneyResult {
  const journey = new Journey({ id: JOURNEY_ID, name: 'Test journey' });
  const journal = new JourneyJournal({ journey_id: JOURNEY_ID, status: 'launched', cursor: step.node_id });
  return {
    journey,
    journal,
    steps: [step],
    currentStep: step,
    cursorIndex: 0,
    loading: false,
    refresh: () => {},
  };
}

describe('useJourneyManager — awaits ride the unified bus', () => {
  let advance: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    EventBus.clear();
    advance = vi
      .spyOn(Journey.prototype, 'advance')
      .mockResolvedValue(new JourneyJournal({ journey_id: JOURNEY_ID }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('event-only await: matching bus event advances the step exactly once', async () => {
    const state = makeState(makeStep({ topic: 'app.page.signal', target: 'next' }));
    renderHook(() => useJourneyManager(state));

    EventBus.emit('app.page.signal', 'next', {}, { origin: 'sandbox' });
    EventBus.emit('app.page.signal', 'next', {}, { origin: 'sandbox' }); // flapping signal

    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    expect(advance).toHaveBeenCalledWith('s1', 'done');
  });

  it('event-only await: wrong target never advances (event-only steps do not auto-satisfy)', async () => {
    const state = makeState(makeStep({ topic: 'app.page.signal', target: 'next' }));
    renderHook(() => useJourneyManager(state));

    EventBus.emit('app.page.signal', 'finish', {}, { origin: 'sandbox' });
    await new Promise((r) => setTimeout(r, 10));
    expect(advance).not.toHaveBeenCalled();
  });

  it('confirm-gated await: event wakes the check, the store query decides', async () => {
    const query = vi.spyOn(dataManager, 'query').mockResolvedValue([]);
    const state = makeState(
      makeStep({
        topic: 'app.entity.created',
        target: 'agent:*',
        confirm: { type: 'agent', match: { kind: 'vibe' }, min: 1 },
      }),
    );
    renderHook(() => useJourneyManager(state));

    // Mount auto-check ran against an empty store — no advance.
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(advance).not.toHaveBeenCalled();

    // Event arrives but the store still says no — event ≠ proof.
    EventBus.emit('app.entity.created', 'agent:123', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(advance).not.toHaveBeenCalled();

    // Store now satisfies the predicate; the next wake-up advances.
    query.mockResolvedValue([{ id: 'a1' } as never]);
    EventBus.emit('app.entity.created', 'agent:123', {});
    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
  });

  it('confirm-gated await auto-satisfies on mount when already true (reload-safety)', async () => {
    vi.spyOn(dataManager, 'query').mockResolvedValue([{ id: 'a1' } as never]);
    const state = makeState(
      makeStep({ topic: 'app.entity.created', target: 'agent:*', confirm: { type: 'agent', min: 1 } }),
    );
    renderHook(() => useJourneyManager(state));

    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    expect(advance).toHaveBeenCalledWith('s1', 'done');
  });
});
