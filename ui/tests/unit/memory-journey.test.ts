import { describe, expect, it, vi } from 'vitest';
import apiClient from '@sdk/client';
import { getMemoryJourney, JourneyGraph, MemoryJourney, registerMemoryJourney } from '@sdk';
import { journeyStep as step } from '../utils/journey-fixtures';

const graph = () => new JourneyGraph({ steps: [step('s1'), step('s2')], start: { kind: 'root' } });

const make = (name: string) => new MemoryJourney({ name, title: 'Probe', graph: graph() });

describe('MemoryJourney — a journey with no folder and no rows', () => {
  it('serves its steps from memory', async () => {
    const journey = make('m1');
    const loaded = await journey.loadSteps();
    expect(loaded.length).toBe(2);
    expect(loaded.start).toEqual({ kind: 'root' });
    expect(journey.projectRoot).toBeNull();
  });

  it('has no journal until launched — which is what makes the tray offer Start', async () => {
    const journey = make('m2');
    expect(journey.currentJournal).toBeNull();
    expect(await journey.progress()).toBeNull();
    expect(await journey.history()).toEqual([]);

    const journal = await journey.launch();
    expect(journal?.cursor).toBe('s1');
    expect(journal?.isActive).toBe(true);
    expect(journal?.steps_left).toBe(2);
  });

  it('launch is idempotent while a run is in progress', async () => {
    const journey = make('m3');
    const first = await journey.launch();
    await journey.advance('s1');
    const second = await journey.launch();
    expect(second).toBe(first);
    expect(second?.cursor).toBe('s2');
  });

  it('walks the graph to completion', async () => {
    const journey = make('m4');
    await journey.launch();

    const mid = await journey.advance('s1');
    expect(mid.cursor).toBe('s2');
    expect(mid.isComplete).toBe(false);
    expect(mid.steps_left).toBe(1);
    expect([...mid.doneNodeIds()]).toEqual(['s1']);

    const end = await journey.advance('s2');
    expect(end.isComplete).toBe(true);
    expect(end.steps_left).toBe(0);
    // The cursor stays on the last step — there is nowhere further to point.
    expect(end.cursor).toBe('s2');
  });

  it('ignores a stale node id, exactly as the server does', async () => {
    const journey = make('m5');
    await journey.launch();
    await journey.advance('s1');
    const again = await journey.advance('s1');
    expect(again.cursor).toBe('s2');
    expect(again.entries).toHaveLength(1);
  });

  it('records a skipped step as behind you', async () => {
    const journey = make('m6');
    await journey.launch();
    const journal = await journey.advance('s1', 'skipped');
    expect(journal.entries?.[0].event).toBe('skipped');
    expect([...journal.doneNodeIds()]).toEqual(['s1']);
  });

  it('restart begins a fresh run after completion', async () => {
    const journey = make('m7');
    await journey.launch();
    await journey.advance('s1');
    await journey.advance('s2');

    const fresh = await journey.restart();
    expect(fresh.cursor).toBe('s1');
    expect(fresh.entries).toEqual([]);
    expect(fresh.isComplete).toBe(false);
    expect(fresh.steps_left).toBe(2);
  });

  it('drives a whole run without a single API call — the point of the class', async () => {
    const get = vi.spyOn(apiClient, 'get');
    const post = vi.spyOn(apiClient, 'post');
    try {
      const journey = make('m8');
      await journey.loadSteps();
      await journey.launch();
      await journey.advance('s1');
      await journey.advance('s2');
      await journey.restart();
      await journey.progress();
      await journey.history();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      post.mockRestore();
    }
  });
});

describe('the memory-journey registry', () => {
  it('is addressed by @uname — the identifier grammar TypeId already accepts', () => {
    const registered = registerMemoryJourney({ name: 'reg-probe', title: 'T', graph: graph() });
    expect(registered.identifier).toBe('@reg-probe');
    // A real TypeId, on the shipped NAMED grammar (`project-@local` is the
    // precedent) — no bespoke prefix was invented for this.
    expect(registered.typeId.toString()).toBe('journey-@reg-probe');
    // The entity id stays an ordinary minted v4: the handle is the uname.
    expect(registered.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getMemoryJourney('@reg-probe')).toBe(registered);
    expect(getMemoryJourney('@absent')).toBeNull();
    expect(getMemoryJourney(null)).toBeNull();
  });

  it('reports authoring problems at registration — the code-built graph has no server to catch them', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerMemoryJourney({
        name: 'bad-probe',
        graph: new JourneyGraph({ steps: [{ ...step('s1'), waitFor: [] }] }),
      });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('waitFor is required'));
    } finally {
      errors.mockRestore();
    }
  });
});
