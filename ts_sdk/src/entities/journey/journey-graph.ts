import {
  GUIDED_ACT_KINDS,
  GUIDED_PRESENT_KINDS,
  type JourneyPresentDock,
  type JourneyStep,
  type JourneyStepGroup,
} from './journey-step';
import { waitConditionProblems, type JourneyWaitFor } from './journey-wait';

/** The raw `graph.json` document shape, as far as the journey cares. */
interface RawGraphDoc {
  start?: JourneyPresentDock;
  nodes?: Array<Record<string, unknown>>;
}

const GUIDED_STEP = 'guided_step';

/**
 * A journey's steps — the thing a journey IS, as an object you can hold.
 *
 * Two ways in, and that is the whole point:
 *
 *  - {@link JourneyGraph.parse} reads an authored `graph.json` (how every
 *    shipped journey arrives);
 *  - the CONSTRUCTOR takes steps directly, so a journey can be written in code.
 *
 * Before this class existed there was only a bare interface that the parser
 * could produce, which meant a journey could not exist without a folder on disk
 * and a row in the graph — no throwaway UX probe, no test fixture that isn't a
 * JSON blob, no `MemoryJourney`.
 *
 * Immutable and dependency-free: no React, no network, no `dataContext`. Every
 * method here is a pure function of the steps, which is what makes the whole
 * journey model provable in a handful of millisecond-scale unit tests.
 */
export class JourneyGraph {
  readonly steps: readonly JourneyStep[];
  /** Journey-level START dock — where a fresh run begins, before the entry
   *  step's own `present`. `{kind:"root"}` = the app home. */
  readonly start: JourneyPresentDock | null;

  constructor(spec: { steps?: readonly JourneyStep[]; start?: JourneyPresentDock | null } = {}) {
    this.steps = spec.steps ?? [];
    this.start = spec.start ?? null;
  }

  /** Parse an authored `graph.json`. Throws on malformed JSON (the caller
   *  decides what an unreadable journey means — see `Journey.loadSteps`). */
  static parse(graphText: string): JourneyGraph {
    const doc = JSON.parse(graphText) as RawGraphDoc;
    return new JourneyGraph({ steps: parseSteps(doc), start: doc.start ?? null });
  }

  get length(): number {
    return this.steps.length;
  }

  get isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** The step a fresh run starts on. */
  get entry(): JourneyStep | null {
    return this.steps[0] ?? null;
  }

  indexOf(nodeId: string | null | undefined): number {
    if (!nodeId) return -1;
    return this.steps.findIndex((s) => s.node_id === nodeId);
  }

  stepAt(nodeId: string | null | undefined): JourneyStep | null {
    const i = this.indexOf(nodeId);
    return i >= 0 ? this.steps[i] : null;
  }

  /** The step after `nodeId`, or null at the end (and for an unknown id). */
  next(nodeId: string | null | undefined): JourneyStep | null {
    const i = this.indexOf(nodeId);
    return i >= 0 ? (this.steps[i + 1] ?? null) : null;
  }

  /**
   * Fold the flat step list into consecutive-`group` sections for rendering:
   * ungrouped steps stand alone, consecutive steps sharing a `group` share a
   * header. Consecutive is deliberate — two separate runs of the same group
   * name stay two sections, so authoring order is never silently reordered.
   */
  get sections(): JourneyStepGroup[] {
    const sections: JourneyStepGroup[] = [];
    this.steps.forEach((step, i) => {
      const group = step.group ?? null;
      const last = sections[sections.length - 1];
      if (last && last.group !== null && last.group === group) last.indices.push(i);
      else sections.push({ group, indices: [i] });
    });
    return sections;
  }

  /**
   * Authoring problems, as human-readable lines — the twin of the Python
   * `GraphWorkflowDoc.problems()` (`graph_workflow_doc.py:258-292`).
   *
   * A file-backed journey is validated server-side on load. A CODE-BUILT one
   * never makes that round trip, so without this a typo'd act kind would simply
   * do nothing at runtime with no explanation. Empty array = no problems.
   */
  problems(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    this.steps.forEach((step, i) => {
      const where = `step ${i} (${step.node_id || 'no node_id'})`;
      if (!step.node_id) out.push(`${where}: missing node_id`);
      else if (seen.has(step.node_id)) out.push(`${where}: duplicate node_id`);
      seen.add(step.node_id);

      const dockKind = step.present?.dock?.kind;
      // The dock is OPTIONAL — a highlight-only step presents in place.
      if (dockKind !== undefined && !GUIDED_PRESENT_KINDS.has(dockKind)) {
        out.push(`${where}: unknown present.dock.kind "${dockKind}"`);
      }
      if (!step.waitFor?.length) out.push(`${where}: waitFor is required`);
      step.waitFor?.forEach((condition) => out.push(...waitConditionProblems(condition, where)));
      if (step.act) {
        if (!GUIDED_ACT_KINDS.has(step.act.kind)) {
          out.push(`${where}: unknown act.kind "${step.act.kind}"`);
        }
        if (!step.act.target) out.push(`${where}: act.target is required`);
      }
    });
    return out;
  }
}

/** Read the guided steps out of a raw graph document, in authored order. */
function parseSteps(doc: RawGraphDoc): JourneyStep[] {
  return (doc.nodes ?? [])
    .filter((n) => (n as { node_type?: string }).node_type === GUIDED_STEP)
    .map((n) => {
      const node = n as unknown as { id: string; name?: string; node_data?: Record<string, unknown> };
      const data = node.node_data ?? {};
      return {
        node_id: node.id,
        name: node.name || node.id,
        status_line: (data.status_line as string) ?? '',
        group: (data.group as string | undefined) || undefined,
        present: (data.present as JourneyStep['present']) ?? {},
        act: (data.act as JourneyStep['act']) ?? undefined,
        waitFor: (data.waitFor as JourneyWaitFor) ?? [],
      };
    });
}
