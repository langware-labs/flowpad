import { Journey } from './journey';
import { JourneyGraph } from './journey-graph';
import { JourneyJournal, type JourneyJournalEntry } from './journey-journal';

/**
 * A journey that exists as CODE — no folder on disk, no rows in the graph, no
 * network call of any kind.
 *
 * A shipped journey is a folder plus a server-owned journal, and that is right
 * for onboarding: it survives reloads, syncs across tabs, and is authored
 * without a rebuild. It is wrong for a journey whose job is to demonstrate the
 * app to ourselves — a UX probe rewritten ten times an hour that must not mint
 * persistent state, and that has to exist before anyone has decided it should
 * ship.
 *
 * Nothing outside this file knows it exists. `Journey`'s backend surface is five
 * methods and one loader; overriding them is enough, because every consumer
 * already goes through those seams. That is the real test of the layering: if
 * this class needed a single change in `ui/`, the logic would still be in the
 * wrong place.
 *
 * DELIBERATE LIMIT — the run lives in this tab, for this page load. A reload
 * reopens the journey (the id is in the URL) but restarts it at step one.
 * Persisting the cursor would need either a server row (the thing this avoids)
 * or a storage key that outlives the code it points into — and for a journey you
 * edit between reloads, a surviving cursor is a stale-cursor bug, not a feature.
 */

export class MemoryJourney extends Journey {
  private readonly graph: JourneyGraph;
  /**
   * The run, as the journal object every consumer already reads — held as ONE
   * instance and mutated in place, which is exactly how the SDK updates
   * server-backed entities. A new object per read would break the tray's
   * completion animation, which keys on the (journal id, status) pair.
   *
   * Null before launch, which is what makes the tray offer its Start button —
   * the same state a server journey that was never launched is in.
   */
  private cached: JourneyJournal | null = null;
  private hydrated = false;

  /**
   * The run, hydrated from (and written through to) per-tab storage.
   *
   * A server journey's run is a row, so a reload finds it again. This one was a
   * field on a module singleton, so refreshing mid-journey silently started it
   * over — against the tray's whole premise that `?journeyId=` restores where
   * you were. `sessionStorage` is the matching durability: it survives a reload
   * and dies with the tab, which is already what "this tab is running the
   * journey" means everywhere else.
   */
  private get run(): JourneyJournal | null {
    if (!this.hydrated) {
      this.cached = this.readRun();
      this.hydrated = true;
    }
    return this.cached;
  }

  private set run(value: JourneyJournal | null) {
    this.cached = value;
    this.hydrated = true;
    this.writeRun();
  }

  /** Keyed by the URL's own handle, so one tab can hold a run per journey. */
  private get storageKey(): string {
    return `flowpad.journey.run.${this.identifier}`;
  }

  /** Absent under SSR/node, and throws outright in some privacy modes — a run
   *  that cannot be persisted still works, it just does not survive a reload. */
  private static storage(): Storage | null {
    try {
      return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      return null;
    }
  }

  private readRun(): JourneyJournal | null {
    const raw = MemoryJourney.storage()?.getItem(this.storageKey);
    if (!raw) return null;
    try {
      // `toJSON` out, constructor in — the same pair every server-backed entity
      // round-trips through, rather than a second hand-rolled shape.
      return new JourneyJournal(JSON.parse(raw) as Partial<JourneyJournal>);
    } catch {
      return null;
    }
  }

  private writeRun(): void {
    const store = MemoryJourney.storage();
    if (!store) return;
    try {
      if (this.cached) store.setItem(this.storageKey, JSON.stringify(this.cached.toJSON()));
      else store.removeItem(this.storageKey);
    } catch {
      // Quota or a locked-down profile: the run stays live in memory.
    }
  }

  /**
   * Addressed by `uname`, so `?journeyId=@vibe-exits` needs no new grammar.
   *
   * An entity id must be a UUID (the id policy, enforced in `TypeId`), so a
   * human-typable handle cannot be one. `APIEntity` already solves that:
   * `identifier` is `@uname` when a uname is set, `TypeId` accepts it as
   * `IdentifierType.NAMED`, and `project-@local` ships on that grammar today.
   * An earlier draft invented a `mem:` prefix instead — a third identifier
   * spelling bolted beside the ones `TypeId` already validates.
   */
  constructor(spec: { name: string; title?: string; graph: JourneyGraph }) {
    // No id passed: APIEntity mints an ordinary UUID v4, so this entity is as
    // well-formed as any other; `uname` is what the URL addresses.
    super({ name: spec.title ?? spec.name, uname: spec.name });
    this.graph = spec.graph;
  }

  /** The whole reason the seam exists: steps from memory, no FSRef. */
  override async loadSteps(): Promise<JourneyGraph> {
    return this.graph;
  }

  /** A code-defined journey ships in no project. */
  override get projectRoot(): string | null {
    return null;
  }

  private freshRun(): JourneyJournal {
    return new JourneyJournal({
      journey_id: this.id,
      status: 'launched',
      cursor: this.graph.entry?.node_id ?? undefined,
      total_steps: this.graph.length,
      steps_left: this.graph.length,
      entries: [],
    });
  }

  /** The live run, read synchronously — what the React binding renders. Null
   *  until launched, which is what makes the tray offer Start. */
  get currentJournal(): JourneyJournal | null {
    return this.run;
  }

  override async progress(): Promise<JourneyJournal | null> {
    return this.currentJournal;
  }

  /** Idempotent, like the server's: an in-progress run is returned as-is. */
  override async launch(): Promise<JourneyJournal | null> {
    if (!this.run || this.run.isComplete) this.run = this.freshRun();
    return this.run;
  }

  override async restart(): Promise<JourneyJournal> {
    this.run = this.freshRun();
    return this.run;
  }

  /**
   * Record the outcome and move the cursor. A stale `nodeId` is a no-op — the
   * same contract the server has, which is what makes the manager's
   * double-advance guard sufficient here too.
   */
  override async advance(nodeId: string, event: 'done' | 'skipped' = 'done'): Promise<JourneyJournal> {
    if (!this.run) this.run = this.freshRun();
    const run = this.run;
    if (run.cursor !== nodeId) return run;
    const next = this.graph.next(nodeId);
    const entry: JourneyJournalEntry = { node_id: nodeId, event, at: new Date().toISOString() };
    run.entries = [...(run.entries ?? []), entry];
    run.cursor = next?.node_id ?? run.cursor;
    run.status = next ? 'launched' : 'complete';
    run.steps_left = Math.max(0, this.graph.length - run.entries.length);
    // Mutated in place (one instance, as the tray's animation requires), so the
    // write-through the setter would have done has to be asked for explicitly.
    this.writeRun();
    return run;
  }

  override async history(): Promise<JourneyJournal[]> {
    return this.run ? [this.run] : [];
  }
}

// ── the registry ──
// Module-scope so a journey registered at import is reachable from the URL.

const registry = new Map<string, MemoryJourney>();

/**
 * Register (or replace) a memory journey. Safe to call at module load.
 *
 * This is where {@link JourneyGraph.problems} earns its keep: an authored
 * journey is validated server-side on load, but a code-built one never makes
 * that round trip, so a typo'd act kind would otherwise just quietly do
 * nothing. Reported, not thrown — a malformed probe journey should still open
 * far enough to show you what is wrong with it.
 */
export function registerMemoryJourney(spec: { name: string; title?: string; graph: JourneyGraph }): MemoryJourney {
  const problems = spec.graph.problems();
  if (problems.length) console.error(`[Journey] "${spec.name}" has authoring problems:\n${problems.join('\n')}`);
  const journey = new MemoryJourney(spec);
  registry.set(journey.identifier, journey);
  return journey;
}

/** The journey registered under a `?journeyId=` identifier (`@name`), or null. */
export function getMemoryJourney(identifier: string | null | undefined): MemoryJourney | null {
  return (identifier && registry.get(identifier)) || null;
}
