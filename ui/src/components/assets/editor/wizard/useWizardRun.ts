import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityProgressSpec } from '@sdk/activity';
import { isTerminal } from '@sdk/activity';
import { ExitCode, type Wizard, type WizardResult, type WizardRunDetail } from '@sdk';

import { useActivitySpec } from '@src/store/activity-store';

/** ONE step's answer — the op's own result (a `CliResult`, a `PromptResult`, an
 *  `AskResult`, a nested `WizardResult`) — with the step it belongs to. */
export type WizardStepAnswer = NonNullable<WizardResult['steps']>[string] & { step_id: string };

/** A wizard that has never run has no answers — as a STABLE identity, so the
 *  memo below is not invalidated on every render by a fresh `[]`. */
const NO_ANSWERS: WizardStepAnswer[] = [];

/** What a step's answer MEANS, in one word. Derived here from the answer's own
 *  fields, never stored. A NOT_YET is told apart by the facts the answer carries
 *  — it used to be "failed" whatever became of it, so a step that timed out, one
 *  a person cancelled and one that never started all read as a failure. */
export function stepStatus(
  answer: Pick<WizardStepAnswer, 'exit_code' | 'ran' | 'timed_out' | 'busy' | 'cancelled'> | null | undefined,
): string {
  if (!answer) return '';
  if (answer.exit_code === ExitCode.NOT_APPLICABLE) return 'not_applicable';
  if (answer.exit_code === ExitCode.OK) return answer.ran === false ? 'satisfied' : 'completed';
  if (answer.exit_code === ExitCode.REFUSED) return 'refused';
  if (answer.exit_code === ExitCode.NOT_FOUND) return 'not_found';
  if (answer.busy) return 'busy'; //               another run held the slot — try later
  if (answer.timed_out) return 'timed_out'; //      the wait ended; the work may still be going
  if (answer.cancelled) return 'cancelled'; //      a person declined to answer
  if (answer.ran === false) return 'not_started'; // nothing ran: no harness, spawn failed
  return 'failed';
}

function answersOf(result: WizardResult | null | undefined): WizardStepAnswer[] {
  return Object.entries(result?.steps ?? {}).map(([step_id, answer]) => ({ ...answer, step_id }));
}

/** One step, as the debugger sees it: what it is doing now, and what it answered. */
export interface WizardRunStep {
  step_id: string;
  live: ActivityProgressSpec | null;
  outcome: WizardStepAnswer | null;
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
 * * **Durable** is `run.json`, stamped when a run settles. It is the only
 *   record of an unattended run, and the only place step output exists.
 *
 * So: live wins while the root is non-terminal (it is the fresher of the two),
 * and the durable answer wins once it settles. Step output is fetched on the
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
      // what went wrong; an unreadable record leaves the durable answers from
      // `run_state` showing, without their output.
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [wizard]);

  // The terminal edge: a run we watched go live has just finished, so its
  // output now exists on disk. One fetch, at the moment there is something new to fetch.
  const live = Boolean(root && !isTerminal(root));
  useEffect(() => {
    if (live) wasLive.current = true;
    else if (wasLive.current) {
      wasLive.current = false;
      void loadDetail();
    }
  }, [live, loadDetail]);

  // `run_state` is AUTHORITATIVE for what each step answered: it rides the
  // entity, so it is refreshed by every run and every reset. `run-detail` is
  // fetched on a gesture and can therefore be older than the entity — letting
  // it win wholesale meant an empty detail left over from a reset hid the
  // answers of the run that followed. So detail contributes only what
  // `strip_heavy` removes on its way to the entity — the step's OUTPUT —
  // matched per step.
  const recordedResult = wizard.run_state?.result;
  const recorded = useMemo(
    () => (recordedResult ? answersOf(recordedResult) : NO_ANSWERS),
    [recordedResult],
  );
  const detailed = detail?.result?.steps;
  const outcomes: WizardStepAnswer[] = useMemo(() => {
    if (!detailed) return recorded;
    return recorded.map((o) => {
      const from = detailed[o.step_id];
      // Only the stripped fields are taken back: everything else on the
      // entity's answer is fresher than this fetch.
      return from
        ? { ...o, stdout: from.stdout, stderr: from.stderr, text: from.text, value: from.value, check: from.check ?? o.check }
        : o;
    });
  }, [recorded, detailed]);

  /** Steps in DOCUMENT order — the order they will run, which is the order a
   *  person reading the editor beside this expects. Answers for steps the
   *  document no longer has are returned separately rather than dropped. */
  const join = useCallback(
    (stepIds: string[]): { steps: WizardRunStep[]; orphaned: WizardStepAnswer[] } => {
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
