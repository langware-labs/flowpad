// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { JourneyGraph, MemoryJourney } from '@sdk';

const graph = () =>
  new JourneyGraph({
    steps: [
      { node_id: 'a', name: 'A', status_line: '', present: {} },
      { node_id: 'b', name: 'B', status_line: '', present: {} },
    ],
  });

describe('a memory journey run survives a reload', () => {
  it('a second instance of the same journey resumes the cursor', async () => {
    const first = new MemoryJourney({ name: 'persist-probe', graph: graph() });
    await first.launch();
    await first.advance('a');
    expect(first.currentJournal?.cursor).toBe('b');

    // A reload is exactly this: the module re-imports and rebuilds the journey.
    const reloaded = new MemoryJourney({ name: 'persist-probe', graph: graph() });
    expect(reloaded.currentJournal?.cursor).toBe('b');
  });

  it('a journey never launched has no run', () => {
    expect(new MemoryJourney({ name: 'untouched-probe', graph: graph() }).currentJournal).toBeNull();
  });
});
