import { APIEntity, registerEntity } from '../../APIEntity';
import { IEntity } from '../../IEntity';
import type { JourneyGraph } from './journey-graph';

/** new → launched → complete, plus `restarted` for a superseded journal. */
export type JourneyStatus = 'new' | 'launched' | 'complete' | 'restarted';

/** One recorded step transition inside a journal. */
export interface JourneyJournalEntry {
  node_id: string;
  event: string;
  at?: string;
}

export interface IJourneyJournal extends IEntity {
  journey_id?: string;
  user_id?: string;
  status?: JourneyStatus;
  run_id?: string;
  cursor?: string;
  total_steps?: number;
  steps_left?: number;
  entries?: JourneyJournalEntry[];
}

// `implements IJourneyJournal` only checks the class; it contributes no members, so every
// field declared solely on IJourneyJournal read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JourneyJournal extends Omit<IJourneyJournal, 'expand' | 'id' | 'is_private' | 'members'> {}

/**
 * Per-user progress through a `Journey` — and THE object every journey
 * method returns (there is no separate progress DTO). `cursor` is the current
 * step node id; `steps_left` is the badge count. The step DESCRIPTORS are not
 * here: they come from the journey's {@link JourneyGraph}, and each step's
 * done/current/upcoming state is derived from `cursor` + `entries` by the
 * accessors below.
 *
 * The backend is the single writer — the frontend only reads this.
 */
@registerEntity
export class JourneyJournal extends APIEntity<JourneyJournal> implements IJourneyJournal {
  static type: string = 'journey_journal';
  journey_id?: string;
  user_id?: string;
  status?: JourneyStatus;
  run_id?: string;
  cursor?: string;
  total_steps?: number;
  steps_left?: number;
  entries?: JourneyJournalEntry[];

  constructor(entity: Partial<IJourneyJournal> = {}) {
    super(entity);
    this.journey_id = entity.journey_id;
    this.user_id = entity.user_id;
    this.status = entity.status;
    this.run_id = entity.run_id;
    this.cursor = entity.cursor;
    this.total_steps = entity.total_steps;
    this.steps_left = entity.steps_left;
    this.entries = entity.entries;
  }

  /** True while this journal is the one being worked on (`new` | `launched`). */
  get isActive(): boolean {
    return this.status === 'new' || this.status === 'launched';
  }

  get isComplete(): boolean {
    return this.status === 'complete';
  }

  /** Where the cursor sits in `graph`, or -1 when it names no known step
   *  (a journal from an older revision of the graph). */
  indexIn(graph: JourneyGraph): number {
    return graph.indexOf(this.cursor);
  }

  /** Node ids with a recorded outcome — done OR skipped. Both are "behind you",
   *  which is what every tick-mark in the tray and viewer means. */
  doneNodeIds(): Set<string> {
    return new Set((this.entries ?? []).map((e) => e.node_id));
  }

  /**
   * THE journal-selection policy: the active journal wins; otherwise the most
   * recently touched one.
   *
   * Never an arbitrary row — an archived `restarted` journal still carries a
   * cursor, and picking it would make the manager re-present a stale step.
   * This lived as a `useMemo` inside a React hook, which meant the rule could
   * not be stated or tested anywhere else even though the badge, the viewer and
   * the tray all depend on it agreeing.
   */
  static pick(journals: readonly JourneyJournal[], journeyId: string | null | undefined): JourneyJournal | null {
    if (!journeyId) return null;
    const mine = journals.filter((j) => j.journey_id === journeyId);
    const active = mine.find((j) => j.isActive);
    if (active) return active;
    // `APIEntity.compare` is the shipped comparator (same call shape as
    // `Project.compare('updated_date')` in use-projects) — and it compares the
    // raw ISO strings rather than parsing, which is well-defined where a
    // Date.parse subtraction would go NaN on a missing date.
    return [...mine].sort(JourneyJournal.compare('updated_date', 'desc'))[0] ?? null;
  }
}
