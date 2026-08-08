import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Capability,
  EventBus,
  QueryFilter,
  QueryRequest,
  capabilityManager,
  dataManager,
  matchesElement,
  matchesLocation,
  Project,
  targetOf,
  TypeId,
  type IDockPointer,
  type JourneyEntityMatch,
  type JourneyWaitCondition,
  type JourneyWaitFor,
} from '@sdk';
import { useTaggedDomChanges } from '@src/tags/use-tagged-dom-changes';

/**
 * The runtime for a step's {@link JourneyWaitFor} — conditions in order, each
 * satisfied before the next is checked.
 *
 * Each kind is observed differently, and that is entirely private to this file —
 * a journey document never says how to watch for something, only what must be
 * true:
 *
 *  - `click` / `event` → a bus subscription
 *  - `element`         → the shared tagged-DOM observer
 *  - `location`        → the dock pointer this hook is handed; a new one
 *                        re-renders and re-evaluates
 *  - `entity`          → the store, re-queried when a row of that type changes
 *  - `manual`          → the tray's Continue, which advances directly
 *
 * NO TIMEOUTS. A stage waits indefinitely; Continue/Skip in the tray is the
 * escape hatch. A wait budget here would be a way to let a step pass while the
 * app is still wrong — the bug this whole mechanism replaces.
 */

export interface WaitContext {
  /** Where the app is (or is going) — matched by `location` conditions. */
  dock: IDockPointer | null;
  /** Scopes an `entity` query to the active project unless it says otherwise. */
  projectId: string | null;
  /** Names the query, for debuggability. */
  label: string;
}

export interface WaitForView {
  /**
   * The armed stage can only be satisfied by the user pressing Next.
   *
   * The tray's Continue is ALREADY the unconditional escape hatch (it advances
   * the step whatever is armed), so `manual` deliberately has no second path of
   * its own — one stage, one way to satisfy it. This flag only tells the tray to
   * light the button rather than leave it dim.
   */
  awaitingManual: boolean;
}

interface Subscription {
  tag: string;
  target?: string;
  /** Firing SATISFIES the condition (an occurrence), rather than merely being a
   *  reason to look at the store again. */
  occurrence: boolean;
}

interface WaitPlan {
  subs: Subscription[];
  watchesDom: boolean;
  entities: JourneyEntityMatch[];
}

/**
 * Everything needed to observe a condition, in ONE walk of the tree.
 *
 * Three separate recursive walks used to do this, re-allocating on every pulse;
 * worse, three copies of the `any`/`all` descent is where grouping semantics
 * drift apart. The evaluator (`stateHolds`) stays separate on purpose — it
 * short-circuits, so it cannot share a flat visit.
 */
function collect(
  condition: JourneyWaitCondition,
  into: WaitPlan = { subs: [], watchesDom: false, entities: [] },
): WaitPlan {
  if ('any' in condition || 'all' in condition) {
    const branches = 'any' in condition ? condition.any : condition.all;
    branches.forEach((c) => collect(c, into));
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
async function entityHolds(spec: JourneyEntityMatch, ctx: WaitContext, fresh: boolean): Promise<boolean> {
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
function stateHolds(
  condition: JourneyWaitCondition,
  ctx: WaitContext,
  fired: boolean,
  satisfied: ReadonlySet<JourneyEntityMatch>,
): boolean {
  if ('any' in condition) {
    return condition.any.some((c) => stateHolds(c, ctx, fired, satisfied));
  }
  if ('all' in condition) {
    return condition.all.every((c) => stateHolds(c, ctx, fired, satisfied));
  }
  if ('element' in condition) return matchesElement(condition.element, document);
  if ('location' in condition) return matchesLocation(ctx.dock, condition.location);
  if ('entity' in condition) return satisfied.has(condition.entity);
  // `manual` is never satisfied here — only the tray's Continue advances it, so
  // an `any: [{manual}, {…}]` reads as "Continue, or the thing happens".
  if ('manual' in condition) return false;
  // click / input / event: satisfied only by having fired while armed.
  return fired;
}

export function useWaitFor(
  stages: JourneyWaitFor | undefined,
  /** Re-arms the whole sequence when it changes — the step's identity. */
  stepKey: string,
  ctx: WaitContext,
  /** `userCaused` carries the envelope attribution of the event that satisfied
   *  the last stage, so the caller can keep the transparency rule: a step the
   *  user reached by their own click must not be yanked elsewhere. */
  onSatisfied: (info: { userCaused: boolean }) => void,
): WaitForView {
  const [index, setIndex] = useState(0);
  /** Non-null once an occurrence fired while armed; carries its attribution. */
  const fired = useRef<{ userCaused: boolean } | null>(null);
  const satisfied = useRef(new Set<JourneyEntityMatch>());
  /** One in-flight query per spec, so concurrent pulses share it rather than
   *  racing — which is what a separate "busy" flag used to approximate, at the
   *  cost of dropping the free element/location check along with it. */
  const inFlight = useRef(new Map<JourneyEntityMatch, Promise<boolean>>());

  // A new step re-arms everything. Occurrences from the previous step must not
  // carry over, or a step could complete on a click that happened before it.
  const reset = () => {
    fired.current = null;
    satisfied.current = new Set();
    inFlight.current = new Map();
  };

  useEffect(() => {
    setIndex(0);
    reset();
  }, [stepKey]);

  const current = stages?.[index];
  const plan = useMemo(() => (current ? collect(current) : null), [current]);

  // Keep the latest ctx/callback without re-subscribing on every render.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const doneRef = useRef(onSatisfied);
  doneRef.current = onSatisfied;

  // "The sequence finished" is not part of computing the next index, so it does
  // not belong inside the updater — a state updater must be pure, and React
  // double-invokes it in dev. An effect keyed on the index fires exactly once.
  useEffect(() => {
    if (stages?.length && index >= stages.length) {
      doneRef.current({ userCaused: !!fired.current?.userCaused });
    }
  }, [index, stages]);

  /** Re-evaluate the armed condition. Idempotent; called on every pulse.
   *  `fromEntityBus` is what makes an entity re-query worth doing. */
  const recheck = useCallback(
    async (fromEntityBus = false) => {
      if (!current || !plan) return;
      // The entity queries are the only expensive part, so they are gated. The
      // free half (element/location) runs on EVERY pulse — it used to be
      // skipped whenever a query was in flight, silently dropping an element
      // that appeared during that window.
      const pending = plan.entities.filter((spec) => !satisfied.current.has(spec));
      if (pending.length && (fromEntityBus || !inFlight.current.size)) {
        await Promise.all(
          pending.map(async (spec) => {
            const shared =
              inFlight.current.get(spec) ??
              entityHolds(spec, ctxRef.current, fromEntityBus).finally(() => inFlight.current.delete(spec));
            inFlight.current.set(spec, shared);
            try {
              if (await shared) satisfied.current.add(spec);
            } catch (e) {
              console.error('[Journey] waitFor entity check failed', e);
            }
          }),
        );
      }
      if (stateHolds(current, ctxRef.current, !!fired.current, satisfied.current)) {
        reset();
        setIndex((i) => i + 1);
      }
    },
    [current, plan],
  );

  // ── the bus ──
  useEffect(() => {
    if (!plan) return;
    const offs = plan.subs.map(({ tag, target, occurrence }) =>
      EventBus.on(
        tag,
        (event) => {
          if (occurrence) {
            // Envelope attribution, stamped at the interaction source — never
            // re-derived by sniffing tag prefixes.
            fired.current = {
              userCaused: (event?.ctx?.actor ?? '').startsWith('user:') && event?.ctx?.origin === 'app',
            };
          }
          void recheck(!occurrence);
        },
        target ? { target } : undefined,
      ),
    );
    // A settled route is what makes a `location` condition worth re-reading.
    offs.push(EventBus.on('app.route.loaded', () => void recheck()));
    return () => offs.forEach((off) => off());
  }, [plan, recheck]);

  // ── the DOM, only while a condition actually watches elements ──
  useTaggedDomChanges(
    useCallback(() => void recheck(), [recheck]),
    !!plan?.watchesDom,
  );

  // ── state conditions can already hold the moment a condition arms (a reload
  // mid-journey, or the app is simply already where the step wants it) ──
  useEffect(() => {
    void recheck();
  }, [recheck, ctx.dock]);

  return {
    awaitingManual: !!current && 'manual' in current,
  };
}
