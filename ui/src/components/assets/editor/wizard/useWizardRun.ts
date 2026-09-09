import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityProgressSpec } from '@sdk/activity';
import { isTerminal } from '@sdk/activity';
import type { Wizard, WizardRunDetail, WizardStepOutcome } from '@sdk';

import { useActivitySpec } from '@src/store/activity-store';

/** A wizard that has never run has no outcomes — as a STABLE identity, so the
 *  memo below is not invalidated on every render by a fresh `[]`. */
const NO_OUTCOMES: WizardStepOutcome[] = [];

/** One step, as the debugger sees it: what it is doing now, and what it did. */
export interface WizardRunStep {
  step_id: string;
  live: ActivityProgressSpec | null;
  outcome: WizardStepOutcome | null;
}

/**
 * The two halves of "what is this run doing", joined on `step_id`.
 *
 * They are genuinely different sources and neither subsumes the other:
 *
 * * **Live** is the Activity tree — present only while a run is in flight, and
 *   only for a run started from THIS viewer. A trigger-fired run is
 *   instance-scoped by design (so it reaches the footer chip), so it produces no
 *   rows here at all. A debugger that pretended live was complete would show an
 *   empty list for the runs people most want to inspect.
 * * **Durable** is `run.json`, stamped when a run settles or parks. It is the
 *   only record of an unattended run, and the only place probes exist.
 *
 * So: live wins while the root is non-terminal (it is the fresher of the two),
 * and the durable outcome wins once it settles. Probes are fetched on the
 * terminal EDGE and on demand — never polled.
 */
export function useWizardRun(wizard: Wizard) {
  // BOTH halves of the address come from the backend: the path is a computed
  // field (re-deriving its slug convention here is how a viewer ends up
  // subscribed to a tree nothing writes to), and the subject is the wizard's
  // own typeid — `run_action` scopes the run to it so the tree reaches this
  // viewer's watchers rather than every connection.
  const root = useActivitySpec(wizard.activity_path ?? '', wizard.typeId.toString());
  const [detail, setDetail] = useState<WizardRunDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Refs, not state: this tracks an EDGE, and putting it in state would make
  // observing the edge itself cause the re-render that re-observes it.
  const wasLive = useRef(false);

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    try {
      setDetail(await wizard.runDetail());
    } catch {
      // The debugger must not be the one screen you cannot open to find out
      // what went wrong; an unreadable record leaves the durable outcomes from
      // `run_state` showing, without probes.
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [wizard]);

  // The terminal edge: a run we watched go live has just finished, so the probes
  // now exist on disk. One fetch, at the moment there is something new to fetch.
  const live = Boolean(root && !isTerminal(root));
  useEffect(() => {
    if (live) wasLive.current = true;
    else if (wasLive.current) {
      wasLive.current = false;
      void loadDetail();
    }
  }, [live, loadDetail]);

  // `run_state` is AUTHORITATIVE for what each step did: it rides the entity,
  // so it is refreshed by every run and every reset. `run-detail` is fetched on
  // a gesture and can therefore be older than the entity — letting it win
  // wholesale meant an empty detail left over from a reset hid the outcomes of
  // the run that followed. So detail contributes the one thing only it has:
  // the probes, matched per step.
  const recorded: WizardStepOutcome[] = wizard.run_state?.outcomes ?? NO_OUTCOMES;
  const probesByStep = detail?.outcomes;
  const outcomes: WizardStepOutcome[] = useMemo(() => {
    if (!probesByStep?.length) return recorded;
    const probes = new Map(probesByStep.map((o) => [o.step_id, o.probes]));
    return recorded.map((o) =>
      probes.has(o.step_id) ? { ...o, probes: probes.get(o.step_id) } : o,
    );
  }, [recorded, probesByStep]);

  /** Steps in DOCUMENT order — the order they will run, which is the order a
   *  person reading the editor beside this expects. Outcomes for steps the
   *  document no longer has are returned separately rather than dropped. */
  const join = useCallback(
    (stepIds: string[]): { steps: WizardRunStep[]; orphaned: WizardStepOutcome[] } => {
      const byId = new Map(outcomes.map((o) => [o.step_id, o]));
      const children = root?.children ?? [];
      const steps = stepIds.map((step_id) => ({
        step_id,
        live: children.find((child) => child.name === step_id) ?? null,
        outcome: byId.get(step_id) ?? null,
      }));
      const known = new Set(stepIds);
      return { steps, orphaned: outcomes.filter((o) => !known.has(o.step_id)) };
    },
    [outcomes, root],
  );

  // Memoized as a whole: an unstable object here would defeat every
  // `useCallback` downstream that lists it as a dependency.
  return useMemo(
    () => ({ live, join, loadDetail, loadingDetail }),
    [live, join, loadDetail, loadingDetail],
  );
}
