import { dataManager } from '../../APIEntity';
import { capabilityManager } from '../../capabilities/CapabilityManager';
import { QueryFilter, QueryRequest } from '../../FlowSync/query';
import { TypeId } from '../../models/TypeId';
import { targetOf } from '../../tags/EventBus';
import { Capability } from '../capability';
import { Project } from '../project';
import type { IDockPointer } from '../../models/DockPointer';
import { matchesElement, matchesLocation } from './journey-wait';
import type { JourneyEntityMatch, JourneyWaitCondition } from './journey-wait';

/**
 * Evaluating a {@link JourneyWaitCondition} — what must be watched, and whether
 * it currently holds.
 *
 * Kept apart from the React runtime on purpose: none of this needs a component,
 * so all of it can be exercised in a plain test. The hook above it owns
 * subscriptions, effects and the arm/advance orchestration; everything here is
 * "given a condition and the world, what is true".
 */

export interface JourneyWaitSubscription {
  tag: string;
  target?: string;
  /** Firing SATISFIES the condition (an occurrence), rather than merely being a
   *  reason to look at the store again. */
  occurrence: boolean;
}

export interface JourneyWaitPlan {
  subs: JourneyWaitSubscription[];
  watchesDom: boolean;
  entities: JourneyEntityMatch[];
}

/** Where an entity condition is resolved, and how its query is scoped. */
export interface JourneyWaitScope {
  /** Scopes an `entity` query to the active project unless it says otherwise. */
  projectId: string | null;
  /** Names the query, for debuggability. */
  label: string;
}

/**
 * Everything needed to observe a condition, in ONE walk of the tree.
 *
 * Three separate recursive walks used to do this, re-allocating on every pulse;
 * worse, three copies of the `any`/`all` descent is where grouping semantics
 * drift apart. The evaluator (`stateHolds`) stays separate on purpose — it
 * short-circuits, so it cannot share a flat visit.
 */
export function waitPlan(
  condition: JourneyWaitCondition,
  into: JourneyWaitPlan = { subs: [], watchesDom: false, entities: [] },
): JourneyWaitPlan {
  if ('any' in condition || 'all' in condition) {
    const branches = 'any' in condition ? condition.any : condition.all;
    branches.forEach((c) => waitPlan(c, into));
    return into;
  }
  if ('event' in condition) {
    into.subs.push({ ...condition.event, occurrence: true });
  } else if ('click' in condition) {
    // `app.ui.*.clicked`, not `app.ui.button.clicked`: the emitter spells the
    // middle segment from the element's own `data-tag-kind`, so pinning it to
    // `button` silently missed every `label`-kind tag — the ViewToggle group
    // among them. The tag WORD is the filter; the kind is the emitter's
    // business. `*` matches exactly one segment (docs/tags.md).
    into.subs.push({ tag: 'app.ui.*.clicked', target: condition.click, occurrence: true });
  } else if ('element' in condition) {
    into.watchesDom = true;
  } else if ('entity' in condition) {
    into.entities.push(condition.entity);
    // The author names a TYPE, never a tag: a row of that type changing is the
    // only reason to re-run the query, and which tag carries that is ours.
    const target = targetOf(condition.entity.type, '*');
    into.subs.push({ tag: 'app.entity.created', target, occurrence: false });
    into.subs.push({ tag: 'app.entity.updated', target, occurrence: false });
  }
  return into;
}

/** Does the store hold enough matching rows? Capabilities are SYSTEM entities
 *  and resolve through their own loader (the generic graph query excludes them);
 *  everything else goes through a scoped query. */
export async function entityMatchHolds(spec: JourneyEntityMatch, ctx: JourneyWaitScope, fresh: boolean): Promise<boolean> {
  const filter = spec.match ? new QueryFilter({ match: spec.match }) : null;
  let rows: unknown[];
  if (spec.type === Capability.type) {
    // `fresh` only when a capability row actually changed — forcing on every
    // pulse re-fetched the whole capability list per animation frame.
    await capabilityManager.load(fresh);
    rows = capabilityManager.getAll();
    if (filter) rows = rows.filter((r) => filter.validate(r));
  } else {
    const scope = ctx.projectId && spec.scope !== 'all' ? [new TypeId(Project.type, ctx.projectId)] : [];
    rows = await dataManager.query(
      new QueryRequest({
        type: spec.type,
        scope,
        name: ctx.label,
        query: spec.local ? null : filter,
      }),
      true,
    );
    if (spec.local && filter) rows = rows.filter((r) => filter.validate(r));
  }
  return rows.length >= (spec.min ?? 1);
}

/** Evaluate the STATE half of a condition. Occurrences are handled separately —
 *  they are satisfied by having happened, and `fired` records that. */
export function waitConditionHolds(
  condition: JourneyWaitCondition,
  dock: IDockPointer | null,
  fired: boolean,
  satisfied: ReadonlySet<JourneyEntityMatch>,
): boolean {
  if ('any' in condition) {
    return condition.any.some((c) => waitConditionHolds(c, dock, fired, satisfied));
  }
  if ('all' in condition) {
    return condition.all.every((c) => waitConditionHolds(c, dock, fired, satisfied));
  }
  if ('element' in condition) return matchesElement(condition.element, document);
  if ('location' in condition) return matchesLocation(dock, condition.location);
  if ('entity' in condition) return satisfied.has(condition.entity);
  // `manual` means "the user's press is what satisfies this" — and pressing Next
  // IS that press, so as a GATE it is always open. It used to mean "only
  // Continue advances it", back when conditions could advance a step by
  // themselves and `manual` was how an author opted out; with the user as the
  // only mover that is now the default, and a step whose sole gate is `manual`
  // would otherwise be one Next could never leave. One is authored today
  // (`getting-started` step3).
  if ('manual' in condition) return true;
  // click / input / event: satisfied only by having fired while armed.
  return fired;
}
