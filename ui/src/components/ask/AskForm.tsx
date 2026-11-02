import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { isOk, type ReturnedValue } from '@sdk';
import apiClient from '@sdk/client';
import { Button } from '@src/components/ui/button';
import { AskAssist, type AssistState } from './AskAssist';
import { AskChoiceBlock } from './AskChoiceBlock';
import { AskSkipButton, SKIPPED } from './AskSkipButton';
import { AskItems, type AskItem } from './AskItems';
import { AskValueInput } from './AskValueInput';
import { type AskQuestion as Question, fieldsOf, hasChoicesOf, useKeepQuestionOpen } from './use-ask-question';
import { useBackendText } from '@src/components/assets/editor/wizard/wizard-texts';
import { MarkdownView } from '@src/components/markdown-view';

/**
 * One question a ComputeOp put to a person — the form, wherever it is drawn.
 *
 * `AskView` draws it as the whole `win/` window; a setup screen showing the wizard run that
 * asked draws it in place (`ask-claims.ts`). The fields come from the op's declared
 * `output_spec_kind`, opened one level by the backend into `fields` — never a hand-written list
 * — and the op's guide (`setup.md`) is drawn above them, because the person is usually copying
 * the value out of another application while reading it.
 *
 * The op on the other end is waiting with a deadline. Cancel is a first-class answer rather
 * than a way to close the form, and a question that has already settled renders as settled.
 */

export function AskForm({
  questionId,
  onSettled,
  showOp = true,
  verifyWith,
}: {
  questionId: string;
  /** Told once the question is answered or cancelled (`'answered'` / `'cancelled'`). */
  onSettled?: (how: 'answered' | 'cancelled') => void;
  /** Show the op's name under the prompt — useful in a bare window, noise inside a wizard. */
  showOp?: boolean;
  /** How the host runs a question's `verify` on the typed values (a source setup dialog: that source's step as a
   *  check): once by itself after a paste, then on the Verify button, the verdict shown in place. */
  verifyWith?: (step: string, values: Record<string, string>) => Promise<Pick<ReturnedValue, 'exit_code' | 'detail'>>;
}) {
  const { _ } = useLingui();
  const bt = useBackendText();
  const [question, setQuestion] = useState<Question | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [settled, setSettled] = useState('');
  const [busy, setBusy] = useState(false);
  /** The verdict of the last verify: the step's own sentence, and whether it passed. */
  const [verdict, setVerdict] = useState<{ ok: boolean; detail: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  /** The one verify a paste runs by itself: armed by the paste, spent by the change that carries its value. */
  const verifyOnPaste = useRef(false);
  useKeepQuestionOpen(settled ? null : questionId);

  useEffect(() => {
    let alive = true;
    setQuestion(null);
    setValues({});
    setSettled('');
    setError('');
    void (async () => {
      const res = await apiClient.get<Question>(`/api/v1/ask/${questionId}`).catch(() => null);
      if (!alive) return;
      // A question that is gone is the NORMAL end: the op timed out, or someone
      // else answered. Say so rather than showing a form that resolves nothing.
      if (!res) setSettled(_(msg`This question is no longer waiting.`));
      else setQuestion(res);
    })();
    return () => {
      alive = false;
    };
  }, [questionId, _]);

  const send = useCallback(
    async (path: '/answer' | '/cancel' | '/skip', body?: unknown) => {
      setBusy(true);
      setError('');
      try {
        await apiClient.post(`/api/v1/ask/${questionId}${path}`, body);
        setSettled(
          path === '/cancel'
            ? _(msg`Cancelled.`)
            : path === '/skip'
              ? _(SKIPPED)
              : _(msg`Thank you — sent.`),
        );
        onSettled?.(path === '/cancel' ? 'cancelled' : 'answered');
      } catch (reason) {
        // A 422 means the value did not match the shape the op declared. The
        // question is still open, so this is correctable in place.
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [questionId, onSettled, _],
  );

  const agentAnswered = useCallback(() => {
    setSettled(_(msg`AI Assist answered it.`));
    onSettled?.('answered');
  }, [onSettled, _]);

  const canVerify = !!(question?.verify && verifyWith);
  const verify = useCallback(
    async (current: Record<string, string>) => {
      if (!question?.verify || !verifyWith) return;
      setVerifying(true);
      setVerdict(null);
      try {
        const names = fieldsOf(question.fields);
        const answer = await verifyWith(question.verify.source_step, Object.fromEntries(names.map((n) => [n || 'value', current[n] ?? ''])));
        setVerdict({ ok: isOk(answer), detail: answer?.detail ?? '' });
      } catch (reason) {
        setVerdict({ ok: false, detail: reason instanceof Error ? reason.message : String(reason) });
      } finally {
        setVerifying(false);
      }
    },
    [question, verifyWith],
  );

  const submit = useCallback(() => {
    const names = fieldsOf(question?.fields ?? null);
    const value =
      names.length === 1 && names[0] === '' ? values[''] : Object.fromEntries(names.map((n) => [n, values[n] ?? '']));
    return send('/answer', { value });
  }, [question, values, send]);

  if (settled) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ask-settled">
        {settled}
      </p>
    );
  }
  if (!question) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }

  const hasChoices = hasChoicesOf(question);
  const items = question.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="ask-view">
      <div>
        {question.stage ? (
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground" data-testid="ask-stage">
            {question.stage.index} of {question.stage.total}
            {question.stage.label ? ` · ${question.stage.label}` : ''}
          </p>
        ) : null}
        <h1 className="whitespace-pre-line text-base font-medium" data-testid="ask-prompt">
          {question.prompt}
        </h1>
        {showOp ? <p className="text-xs text-muted-foreground">{question.op}</p> : null}
      </div>

      {question.detail ? (
        <div className="text-sm text-muted-foreground" data-testid="ask-detail">
          <MarkdownView value={question.detail} compact dataImages />
        </div>
      ) : null}

      <AskChoiceBlock
        choices={question.choices}
        busy={busy}
        submitLabel={question.submit_label ? bt(question.submit_label) : undefined}
        onAnswer={(value) => void send('/answer', { value })}
      />

      {items.length > 0 ? (
        <AskItems
          items={items}
          busy={busy}
          onAnswer={(value) => void send('/answer', { value })}
          onCancel={() => void send('/cancel')}
        />
      ) : null}

      {(hasChoices || items.length > 0 ? [] : fieldsOf(question.fields)).map((name) => (
        <div key={name} className="flex flex-col gap-1">
          {name ? (
            <label className="text-sm" htmlFor={`ask-${name}`} data-testid={`ask-label-${name}`}>
              {question.labels?.[name] ?? name}
            </label>
          ) : null}
          <AskValueInput
            id={`ask-${name}`}
            testId={`ask-input-${name || 'value'}`}
            secret={question.secret}
            file={question.file}
            value={values[name] ?? ''}
            onChange={(value) => {
              const next = { ...values, [name]: value };
              setValues(next);
              if (verifyOnPaste.current) {
                verifyOnPaste.current = false;
                void verify(next);
              }
            }}
            onEnter={() => void submit()}
            onPaste={canVerify && !verdict ? () => (verifyOnPaste.current = true) : undefined}
          />
        </div>
      ))}

      {canVerify ? (
        <div className="flex items-center gap-3" data-testid="ask-verify">
          <Button variant="outline" size="sm" data-testid="ask-verify-button" disabled={busy || verifying} onClick={() => void verify(values)}>
            {verifying ? <Loader2 className="size-4 animate-spin" /> : null}
            {question.verify?.label ? bt(question.verify.label) : <Trans>Verify</Trans>}
          </Button>
          {verdict ? (
            <span
              className={verdict.ok ? 'text-sm text-emerald-600 dark:text-emerald-400' : 'text-sm text-destructive'}
              data-testid="ask-verify-verdict"
              data-ok={verdict.ok ? 'true' : 'false'}
            >
              {verdict.detail}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          className="rounded border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-foreground"
          data-testid="ask-error"
        >
          {error}
        </p>
      ) : null}

      {items.length > 0 ? null : (
        <div className="flex items-center gap-2">
          {hasChoices ? null : question.auto ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-auto-waiting">
              <Loader2 className="size-4 animate-spin" />
              <Trans>Waiting…</Trans>
            </span>
          ) : (
            <Button data-testid="ask-submit" disabled={busy} onClick={() => void submit()}>
              {question.submit_label ? bt(question.submit_label) : <Trans>Send</Trans>}
            </Button>
          )}
          <Button variant="ghost" data-testid="ask-cancel" disabled={busy} onClick={() => void send('/cancel')}>
            {question.cancel_label ? bt(question.cancel_label) : <Trans>Cancel</Trans>}
          </Button>
        </div>
      )}

      <AskSkipButton skippable={question.skippable} busy={busy} onSkip={() => void send('/skip')} />

      {/* Help comes after the inputs: the answer is the point of the screen, the how-to is for whoever needs it. */}
      <AskAssist
        questionId={questionId}
        available={question.assist_available}
        initial={question.assist}
        onAnswered={agentAnswered}
      />

      {question.guide ? (
        <details className="text-sm" data-testid="ask-guide">
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>How do I get it?</Trans>
          </summary>
          <div className="mt-2 rounded border bg-muted/30 p-3">
            <MarkdownView value={question.guide} compact />
          </div>
        </details>
      ) : null}
    </div>
  );
}
