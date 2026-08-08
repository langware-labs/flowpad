import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EventBus,
  entityMatchHolds,
  waitConditionHolds,
  waitPlan,
  type IDockPointer,
  type JourneyEntityMatch,
  type JourneyWaitFor,
  type JourneyWaitScope,
} from '@sdk';
import { useTaggedDomChanges } from '@src/tags/use-tagged-dom-changes';

/**
 * A step's {@link JourneyWaitFor}, evaluated as a GATE.
 *
 * It answers one question — *may a pressed Next land yet?* — and does nothing
 * else. It never advances a step, never calls back, never holds a cursor.
 *
 * That is the whole point. Conditions used to DRIVE navigation, so two things
 * moved a journey: the user pressing Next, and the app happening to satisfy a
 * condition. Every flake came from that collision — steps that completed in the
 * commit they rendered in, one click cascading through six steps, a step
 * advancing while the app was still moving. With the user as the only mover,
 * none of those are expressible.
 *
 * Each kind is observed differently, and that stays private to this file — a
 * journey document says what must be true, never how to watch for it:
 *
 *  - `click` / `event` → a bus subscription; LATCHES once seen (an occurrence is
 *                        satisfied by having happened, and only since this step
 *                        loaded — a click from the previous step must not count)
 *  - `element`         → the shared tagged-DOM observer
 *  - `location`        → the dock pointer this hook is handed
 *  - `entity`          → the store, re-queried when a row of that type changes
 *  - `manual`          → never satisfied here; the press itself is the answer
 *
 * Conditions are an unordered SET: all must hold. The old ordered stage cursor
 * is gone — it was the mechanism behind the cascade, and ordering never carried
 * meaning a set doesn't.
 *
 * NO TIMEOUTS. A gate waits indefinitely; Skip is the escape hatch. A wait
 * budget here would let a step pass while the app is still wrong, which is the
 * bug this mechanism exists to prevent.
 */

/** Where the app is, plus how an `entity` condition is scoped and named. The
 *  scope half is the SDK's — this only adds the dock the hook is handed. */
export interface WaitContext extends JourneyWaitScope {
  /** Where the app is (or is going) — matched by `location` conditions. */
  dock: IDockPointer | null;
}

export interface WaitGate {
  /** True when every condition holds — or when the step authored none. */
  satisfied: boolean;
}

/** A gate with nothing to wait for is open; shared so the empty case allocates
 *  nothing and compares stably. */
const OPEN: WaitGate = { satisfied: true };

export function useWaitGate(
  conditions: JourneyWaitFor | undefined,
  /** Re-arms the gate when it changes — the step's identity. */
  stepKey: string,
  ctx: WaitContext,
): WaitGate {
  const [satisfied, setSatisfied] = useState(false);
  /** Indices of occurrence conditions that have fired since this step loaded. */
  const fired = useRef(new Set<number>());
  const entities = useRef(new Set<JourneyEntityMatch>());
  /** One in-flight query per spec, so concurrent pulses share it rather than
   *  racing — a separate "busy" flag used to approximate this, at the cost of
   *  dropping the free element/location check along with it. */
  const inFlight = useRef(new Map<JourneyEntityMatch, Promise<boolean>>());

  // One plan PER condition, not one flattened plan: a firing subscription has to
  // say which condition it satisfied, and a flat list cannot.
  const plans = useMemo(() => (conditions ?? []).map((c) => waitPlan(c)), [conditions]);

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    fired.current = new Set();
    entities.current = new Set();
    inFlight.current = new Map();
    setSatisfied(false);
  }, [stepKey]);

  const evaluate = useCallback(
    async (fromEntityBus = false) => {
      if (!conditions?.length) return;
      const pending = plans.flatMap((p) => p.entities).filter((spec) => !entities.current.has(spec));
      // The entity queries are the only expensive part, so they are gated. The
      // free half (element/location) runs on EVERY pulse — it used to be skipped
      // whenever a query was in flight, silently dropping an element that
      // appeared during that window.
      if (pending.length && (fromEntityBus || !inFlight.current.size)) {
        await Promise.all(
          pending.map(async (spec) => {
            const shared =
              inFlight.current.get(spec) ??
              entityMatchHolds(spec, ctxRef.current, fromEntityBus).finally(() => inFlight.current.delete(spec));
            inFlight.current.set(spec, shared);
            try {
              if (await shared) entities.current.add(spec);
            } catch (e) {
              console.error('[Journey] waitFor entity check failed', e);
            }
          }),
        );
      }
      setSatisfied(
        conditions.every((c, i) => waitConditionHolds(c, ctxRef.current.dock, fired.current.has(i), entities.current)),
      );
    },
    [conditions, plans],
  );

  // ── the bus ──
  useEffect(() => {
    if (!plans.length) return;
    const offs = plans.flatMap((plan, i) =>
      plan.subs.map(({ tag, target, occurrence }) =>
        EventBus.on(
          tag,
          () => {
            if (occurrence) fired.current.add(i);
            void evaluate(!occurrence);
          },
          target ? { target } : undefined,
        ),
      ),
    );
    // A settled route is what makes a `location` condition worth re-reading.
    offs.push(EventBus.on('app.route.loaded', () => void evaluate()));
    return () => offs.forEach((off) => off());
  }, [plans, evaluate]);

  // ── the DOM, only while a condition actually watches elements ──
  useTaggedDomChanges(
    useCallback(() => void evaluate(), [evaluate]),
    plans.some((p) => p.watchesDom),
  );

  // A gate is read the moment the step loads, and again whenever the app moves:
  // "already true on arrival" is the normal case for a gate (unlike the old
  // driver, where it meant a step could complete itself unseen).
  useEffect(() => {
    void evaluate();
  }, [evaluate, ctx.dock]);

  return conditions?.length ? { satisfied } : OPEN;
}
