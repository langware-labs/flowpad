// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { dataManager, EventBus, Journey, JourneyGraph, JourneyJournal, type JourneyStep } from '@sdk';
import { useJourneyManager } from '@src/journey/useJourneyManager';
import type { UseJourneyResult } from '@src/journey/use-journey';

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

function makeStep(waitFor: JourneyStep['waitFor']): JourneyStep {
  return { node_id: 's1', name: 'Step 1', status_line: '', present: {}, waitFor };
}

function makeState(step: JourneyStep): UseJourneyResult {
  const journey = new Journey({ id: JOURNEY_ID, name: 'Test journey' });
  const journal = new JourneyJournal({ journey_id: JOURNEY_ID, status: 'launched', cursor: step.node_id });
  return {
    journey,
    journal,
    graph: new JourneyGraph({ steps: [step] }),
    currentStep: step,
    cursorIndex: 0,
    loading: false,
    refresh: () => {},
  };
}

describe('useJourneyManager — a step advances when its conditions hold', () => {
  let advance: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    EventBus.clear();
    advance = vi
      .spyOn(Journey.prototype, 'advance')
      .mockResolvedValue(new JourneyJournal({ journey_id: JOURNEY_ID }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('an occurrence: the matching bus event advances the step exactly once', async () => {
    const state = makeState(makeStep([{ event: { tag: 'app.page.signal', target: 'next' } }]));
    renderHook(() => useJourneyManager(state));

    EventBus.emit('app.page.signal', 'next', {}, { origin: 'sandbox' });
    EventBus.emit('app.page.signal', 'next', {}, { origin: 'sandbox' }); // flapping signal

    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    expect(advance).toHaveBeenCalledWith('s1', 'done');
  });

  it('an occurrence never satisfies itself: a wrong target does not advance', async () => {
    const state = makeState(makeStep([{ event: { tag: 'app.page.signal', target: 'next' } }]));
    renderHook(() => useJourneyManager(state));

    EventBus.emit('app.page.signal', 'finish', {}, { origin: 'sandbox' });
    await new Promise((r) => setTimeout(r, 10));
    expect(advance).not.toHaveBeenCalled();
  });

  it('a state condition: the store decides, and a row changing is what re-asks it', async () => {
    const query = vi.spyOn(dataManager, 'query').mockResolvedValue([]);
    const state = makeState(makeStep([{ entity: { type: 'agent', match: { kind: 'vibe' }, min: 1 } }]));
    renderHook(() => useJourneyManager(state));

    // Asked once on arrival, against an empty store — no advance.
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(advance).not.toHaveBeenCalled();

    // A row of that type changed, but the store still says no.
    EventBus.emit('app.entity.created', 'agent:123', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(advance).not.toHaveBeenCalled();

    // Now it says yes. The author never named a tag for any of this.
    query.mockResolvedValue([{ id: 'a1' } as never]);
    EventBus.emit('app.entity.created', 'agent:123', {});
    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
  });

  it('a state condition already true on arrival advances at once (reload-safety)', async () => {
    vi.spyOn(dataManager, 'query').mockResolvedValue([{ id: 'a1' } as never]);
    const state = makeState(makeStep([{ entity: { type: 'agent', min: 1 } }]));
    renderHook(() => useJourneyManager(state));

    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
    expect(advance).toHaveBeenCalledWith('s1', 'done');
  });

  it('an occurrence THEN a state condition — the shape that stops a step narrating ahead', async () => {
    const query = vi.spyOn(dataManager, 'query').mockResolvedValue([{ id: 'a1' } as never]);
    const state = makeState(
      makeStep([{ event: { tag: 'app.page.signal', target: 'go' } }, { entity: { type: 'agent', min: 1 } }]),
    );
    renderHook(() => useJourneyManager(state));

    // The state is ALREADY true, but the occurrence has not happened — so the
    // step must not advance. This is what `fresh` used to mean, without a flag.
    await new Promise((r) => setTimeout(r, 10));
    expect(advance).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();

    EventBus.emit('app.page.signal', 'go', {}, { origin: 'sandbox' });
    await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
  });
});
