import { describe, expect, it } from 'vitest';
import { JourneyGraph, JourneyJournal } from '@sdk';
import { GETTING_STARTED_JOURNEY_ID, journeyStep as step } from '../utils/journey-fixtures';
import { uid } from '../utils/terminal-tab-fixtures';

const GRAPH = new JourneyGraph({ steps: [step('s1'), step('s2'), step('s3')] });
const JOURNEY = GETTING_STARTED_JOURNEY_ID;
// Two fixture rules, both learned the hard way:
//  - ids must be UNIQUE PER CASE — the SDK entity registry is global, so a
//    re-used id hands back the first instance and ignores the new fields;
//  - `updated_date` must be an ISO STRING, which is what the wire delivers.
//    `deepAssign` deep-merges plain objects, so a real `Date` lands as `{}`.

describe('JourneyJournal — progress derivations', () => {
  it('isFresh only while nothing has been recorded', () => {
    expect(new JourneyJournal({ cursor: 's1' }).isFresh).toBe(true);
    expect(new JourneyJournal({ entries: [] }).isFresh).toBe(true);
    expect(new JourneyJournal({ entries: [{ node_id: 's1', event: 'done' }] }).isFresh).toBe(false);
  });

  it('locates the cursor in a graph, and survives a cursor the graph no longer has', () => {
    expect(new JourneyJournal({ cursor: 's2' }).indexIn(GRAPH)).toBe(1);
    expect(new JourneyJournal({ cursor: 's2' }).currentStep(GRAPH)?.node_id).toBe('s2');
    // A journal written against an older revision of the graph.
    expect(new JourneyJournal({ cursor: 'gone' }).indexIn(GRAPH)).toBe(-1);
    expect(new JourneyJournal({ cursor: 'gone' }).currentStep(GRAPH)).toBeNull();
    expect(new JourneyJournal({}).indexIn(GRAPH)).toBe(-1);
  });

  it('counts a SKIPPED step as behind you, same as a done one', () => {
    const journal = new JourneyJournal({
      entries: [
        { node_id: 's1', event: 'done' },
        { node_id: 's2', event: 'skipped' },
      ],
    });
    expect([...journal.doneNodeIds()].sort()).toEqual(['s1', 's2']);
  });

  it('isComplete tracks only the terminal status', () => {
    expect(new JourneyJournal({ status: 'complete' }).isComplete).toBe(true);
    expect(new JourneyJournal({ status: 'launched' }).isComplete).toBe(false);
  });
});

describe('JourneyJournal.pick — which journal is the one you are on', () => {
  const journal = (over: Partial<ConstructorParameters<typeof JourneyJournal>[0]>) =>
    new JourneyJournal({ journey_id: JOURNEY, ...over });

  it('prefers the ACTIVE journal over a more recent finished one', () => {
    const active = journal({ id: uid('active'), status: 'launched', updated_date: '2020-01-01T00:00:00Z' as never });
    const newer = journal({ id: uid('newer'), status: 'complete', updated_date: '2030-01-01T00:00:00Z' as never });
    expect(JourneyJournal.pick([newer, active], JOURNEY)?.id).toBe(uid('active'));
  });

  it('falls back to the most recently touched journal when none is active', () => {
    const old = journal({ id: uid('older'), status: 'complete', updated_date: '2020-01-01T00:00:00Z' as never });
    const recent = journal({ id: uid('recent'), status: 'complete', updated_date: '2026-01-01T00:00:00Z' as never });
    expect(JourneyJournal.pick([old, recent], JOURNEY)?.id).toBe(uid('recent'));
  });

  it('never picks another journey\'s journal', () => {
    const other = new JourneyJournal({ id: uid('other'), journey_id: 'other', status: 'launched' });
    expect(JourneyJournal.pick([other], JOURNEY)).toBeNull();
  });

  it('is null with no journeyId and with no rows', () => {
    expect(JourneyJournal.pick([journal({ id: uid('lone'), status: 'launched' })], null)).toBeNull();
    expect(JourneyJournal.pick([], JOURNEY)).toBeNull();
  });
});
