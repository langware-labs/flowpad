import { useCallback, useEffect, useMemo, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { TypeId, Wizard } from '@sdk';
import { deepestRunning } from '@sdk/activity';
import apiClient from '@sdk/client';
import { useEntity } from '@sdk/react/hooks';
import { showWizard } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { pickLiveActivity, useActivitySpec } from '@src/store/activity-store';
import type { AssistState } from './AskAssist';
import type { AskItem } from './AskItems';

/**
 * A question a ComputeOp put to a person — the data and actions behind it,
 * shared by both places it can be shown: the full-page `/dock/ask/<id>` route
 * (`AskView`, still used for the no-live-tab `win/` fallback) and the modal a
 * live tab gets instead (`AskModal`). Neither owns this; both are thin
 * renderings of it.
 */

/** How often a screen showing a question tells the backend so. Under the backend's ``SEEN_SECONDS`` (60 s):
 *  a question someone has open never times out, one nobody shows any more ends a minute later. */
export const KEEP_OPEN_MS = 20_000;

/** One timer per question on screen, however many screens show it (a modal over a dialog with the same form). */
const keepingOpen = new Map<string, { screens: number; timer: ReturnType<typeof setInterval> }>();

/** While `questionId` is on screen, the op asking it keeps waiting for the answer. */
export function useKeepQuestionOpen(questionId: string | null | undefined): void {
  useEffect(() => {
    if (!questionId) return;
    const held = keepingOpen.get(questionId);
    if (held) {
      held.screens += 1;
    } else {
      const say = () => void Promise.resolve(apiClient.post(`/api/v1/ask/${questionId}/seen`)).catch(() => undefined);
      say();
      keepingOpen.set(questionId, { screens: 1, timer: setInterval(say, KEEP_OPEN_MS) });
    }
    return () => {
      const entry = keepingOpen.get(questionId);
      if (!entry || (entry.screens -= 1) > 0) return;
      clearInterval(entry.timer);
      keepingOpen.delete(questionId);
    };
  }, [questionId]);
}

export type Shape = Record<string, unknown> | string | null;

/** One way to answer a "pick one way" question (`AskChoiceBlock`). */
export interface AskChoice {
  /** What the answer names — a variable. */
  value: string;
  label: string;
  hint: string;
  /** Where to get the value — a link under its input. */
  help_url?: string;
  /** The example shown in an empty input. */
  placeholder?: string;
  secret: boolean;
  file: boolean;
  /** A sign-in command: nothing is typed, the person runs it. Empty: a value is typed. */
  command: string;
  /** A sign-in through Flowpad: the screen connects this provider (its grant covering `scopes`), then answers
   *  the choice's `value` — nothing typed, nothing stored. Empty: not this kind of way. */
  provider?: string;
  scopes?: string[];
  /** A way of several values given together: one input per field, answered as newline-joined
   *  `<field.value>=<typed>` lines. Empty: the choice is one value (or a sign-in). */
  fields?: AskChoice[];
}

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
  /** The answer is a file's content (a key file): drawn as a file picker. */
  file?: boolean;
  /** The ways to answer, when there is more than one; empty for every ordinary question. */
  choices?: AskChoice[];
  /** Several questions asked as one (`AskItems`); empty for every ordinary question. */
  items?: AskItem[];
  /** The Wizard this question is one step of, when it is one. Empty for a
   *  question an op raised outside any wizard. */
  wizard_id?: string;
  /** How a person finds the value — the op's `setup.md`, markdown. */
  guide?: string;
  /** The op names an agent that can answer instead (AI Assist). */
  assist_available?: boolean;
  assist?: AssistState | null;
}

export const hasChoicesOf = (question: { choices?: AskChoice[] } | null) => !!question?.choices?.length;

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

  useKeepQuestionOpen(settledKind ? null : questionId);

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

  /** A chosen way's answer (`AskChoiceBlock`, one string) or a list's (`AskItems`), sent as it is. */
  const answer = useCallback((value: string | Record<string, unknown>) => send('/answer', { value }), [send]);

  const cancel = useCallback(() => send('/cancel'), [send]);
  /** The cards are the form (`AskChoiceBlock`): no bare field, and no Send of the question's own. */
  const hasChoices = hasChoicesOf(question);
  /** The question settled while AI Assist worked on it: the agent answered. */
  const agentAnswered = useCallback(() => setSettledKind('answered'), []);

  // This question is one step of a Wizard that is still running the next one
  // right now — the answer just unblocked it. Opening the wizard's own editor
  // is where its live per-step status already lives (`WizardViewer`); the
  // button a caller renders is only the door to it, not a second copy of it.
  const wizardId = question?.wizard_id;
  const wizardTypeId = useMemo(() => (wizardId ? new TypeId(Wizard.type, wizardId) : null), [wizardId]);
  const openWizard = useCallback(() => {
    if (!wizardTypeId) return;
    void showWizard(navigation, wizardTypeId);
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
    hasChoices,
    values,
    setValues,
    error,
    busy,
    settledKind,
    settledMessage,
    submit,
    answer,
    cancel,
    agentAnswered,
    wizardId,
    openWizard,
    runningNow,
  };
}
