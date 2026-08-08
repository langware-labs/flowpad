/**
 * The Journey domain model.
 *
 * Explicit named re-exports (the `compute-node/` convention), split into values
 * and types so it is obvious at a glance which symbols exist at runtime.
 *
 * `entities/index.ts` does `export * from './journey'` and resolves it here, so
 * every consumer keeps importing plain `@sdk`.
 */

// The entities.
export { Journey } from './journey';
export type { IJourney } from './journey';
export { JourneyJournal } from './journey-journal';
export type { IJourneyJournal, JourneyJournalEntry, JourneyStatus } from './journey-journal';

// The steps value class — the object a journey's guidance IS.
export { JourneyGraph } from './journey-graph';

// Code-defined journeys — no folder, no rows, no network.
export { getMemoryJourney, MemoryJourney, registerMemoryJourney } from './memory-journey';

// What a step waits for — one vocabulary for every kind of "not yet".
export { GUIDED_WAIT_KINDS, matchesElement, matchesLocation, waitConditionProblems } from './journey-wait';
export type {
  JourneyElementMatch,
  JourneyEntityMatch,
  JourneyLocationMatch,
  JourneyWaitCondition,
  JourneyWaitFor,
} from './journey-wait';

// The authoring vocabulary (twinned with the Python validator).
export { GUIDED_ACT_KINDS, GUIDED_PRESENT_KINDS } from './journey-step';
export type {
  JourneyActKind,
  JourneyActSpec,
  JourneyPresentDock,
  JourneyStep,
  JourneyStepGroup,
} from './journey-step';
