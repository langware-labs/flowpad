import type { JourneyStep } from '@sdk';

/**
 * Shared journey test fixtures. The `step()` builder was pasted into five test
 * files; the point of a step fixture is that the boring fields are boring, so
 * there is no reason for five spellings of them.
 *
 * Entity ids come from `uid()` in `terminal-tab-fixtures` — TypeId enforces the
 * UUID v4/v5 id policy, so a test id has to be a real one.
 */
export function journeyStep(node_id: string, over: Partial<JourneyStep> = {}): JourneyStep {
  return {
    node_id,
    name: node_id,
    status_line: '',
    present: {},
    waitFor: [{ manual: true }],
    ...over,
  };
}

/** The shipped "getting started" journey's id — the one real journey id the
 *  tests address, kept in one place rather than three. */
export const GETTING_STARTED_JOURNEY_ID = '5eaa7e57-1111-4222-8333-444455556666';
