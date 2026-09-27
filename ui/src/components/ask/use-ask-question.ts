import { useCallback, useEffect, useMemo, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { TypeId, Wizard } from '@sdk';
import { deepestRunning } from '@sdk/activity';
import apiClient from '@sdk/client';
import { useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { pickLiveActivity, useActivitySpec } from '@src/store/activity-store';

/**
 * A question a ComputeOp put to a person — the data and actions behind it,
 * shared by both places it can be shown: the full-page `/dock/ask/<id>` route
 * (`AskView`, still used for the no-live-tab `win/` fallback) and the modal a
 * live tab gets instead (`AskModal`). Neither owns this; both are thin
 * renderings of it.
 */

export type Shape = Record<string, unknown> | string | null;

export interface AskQuestion {
  id: string;
  op: string;
  prompt: string;
  /** Why it is asked and what each answer does. Empty: the op's name instead. */
  detail?: string;
  /** The op's words for the two buttons. Empty: the defaults, Send / Cancel. */
  submit_label?: string;
  cancel_label?: string;
  /** The declared kind opened one level: `{field: form}`, or the kind itself for a scalar. */
  fields: Shape;
  /** The answer is a secret (an API key): drawn masked. */
  secret?: boolean;
  /** The Wizard this question is one step of, when it is one. Empty for a
   *  question an op raised outside any wizard. */
  wizard_id?: string;
}

/** The field names to draw. An object shape is its keys; anything else is one
 *  unnamed value, which is what a scalar declaration means. */
export function fieldsOf(shape: Shape): string[] {
  if (shape && typeof shape === 'object' && !Array.isArray(shape)) return Object.keys(shape);
  return [''];
}

export function useAskQuestion(questionId: string | undefined) {
  const { _ } = useLingui();
  const { navigation } = useDockNavigation();
  const [question, setQuestion] = useState<AskQuestion | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  // The KIND of ending, not its text — the text depends on whether there is
  // something better to show instead (see `settledMessage` below), which can
  // only be decided once `wizardId` is known.
  const [settledKind, setSettledKind] = useState<'' | 'gone' | 'cancelled' | 'answered'>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!questionId) return;
    let alive = true;
    void (async () => {
      const res = await apiClient.get<AskQuestion>(`/api/v1/ask/${questionId}`).catch(() => null);
      if (!alive) return;
      // A question that is gone is the NORMAL end: the op timed out, or someone
      // else answered. Say so rather than showing a form that resolves nothing.
      if (!res) setSettledKind('gone');
      else setQuestion(res);
    })();
    return () => {
      alive = false;
    };
  }, [questionId]);

  const send = useCallback(
    async (path: string, body?: unknown) => {
      if (!questionId) return;
      setBusy(true);
      setError('');
      try {
        await apiClient.post(`/api/v1/ask/${questionId}${path}`, body);
        setSettledKind(path === '/cancel' ? 'cancelled' : 'answered');
      } catch (reason) {
        // A 422 means the value did not match the shape the op declared. The
        // question is still open, so this is correctable in place.
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [questionId],
  );

  const submit = useCallback(() => {
    const names = fieldsOf(question?.fields ?? null);
    const value =
      names.length === 1 && names[0] === '' ? values[''] : Object.fromEntries(names.map((n) => [n, values[n] ?? '']));
    return send('/answer', { value });
  }, [question, values, send]);

  const cancel = useCallback(() => send('/cancel'), [send]);

  // This question is one step of a Wizard that is still running the next one
  // right now — the answer just unblocked it. Opening the wizard's own editor
  // is where its live per-step status already lives (`WizardViewer`); the
  // button a caller renders is only the door to it, not a second copy of it.
  const wizardId = question?.wizard_id;
  const wizardTypeId = useMemo(() => (wizardId ? new TypeId(Wizard.type, wizardId) : null), [wizardId]);
  const openWizard = useCallback(() => {
    if (!wizardTypeId) return;
    navigation.openDock(DockPointer.forAssetEditorByTypeId('wizard', wizardTypeId));
  }, [navigation, wizardTypeId]);

  // ...and the one thing worth showing without leaving here at all: whatever
  // is running RIGHT NOW, read from the same Activity tree a step's row in
  // `WizardViewer` reads — not a second copy of that view, just its live text.
  const { data: wizardEntity } = useEntity<Wizard>(wizardTypeId);
  const activityPath = wizardEntity?.activity_path ?? '';
  const scopedActivity = useActivitySpec(activityPath, wizardTypeId?.toString());
  const unattendedActivity = useActivitySpec(activityPath, undefined);
  const runningNow = useMemo(
    () => deepestRunning(pickLiveActivity(scopedActivity, unattendedActivity)),
    [scopedActivity, unattendedActivity],
  );

  // A generic "it was sent" is only worth saying when there is nothing more
  // specific to show — a wizard's answer already has a better next step (the
  // caller's own button/status), so the plain sentence would just repeat what
  // that already says, less usefully.
  const settledMessage = useMemo(() => {
    if (settledKind === 'gone') return _(msg`This question is no longer waiting.`);
    if (settledKind === 'cancelled') return _(msg`Cancelled.`);
    if (settledKind === 'answered') return wizardId ? null : _(msg`Got it — your answer was sent.`);
    return null;
  }, [settledKind, wizardId, _]);

  return {
    question,
    values,
    setValues,
    error,
    busy,
    settledKind,
    settledMessage,
    submit,
    cancel,
    wizardId,
    openWizard,
    runningNow,
  };
}
