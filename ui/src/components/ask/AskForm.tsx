import { useCallback, useEffect, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import apiClient from '@sdk/client';
import { Button } from '@src/components/ui/button';
import { AskAssist, type AssistState } from './AskAssist';
import { AskValueInput } from './AskValueInput';
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

type Shape = Record<string, unknown> | string | null;

interface Question {
  id: string;
  op: string;
  prompt: string;
  /** The declared kind opened one level: `{field: form}`, or the kind itself for a scalar. */
  fields: Shape;
  /** The answer is a secret (an API key): drawn masked. */
  secret?: boolean;
  /** The answer is a file's content (a key file): drawn as a file picker. */
  file?: boolean;
  /** Why it is asked and what to do — markdown; a gate's "not yet" reason is appended to it. */
  detail?: string;
  /** How a person finds the value — the op's `setup.md`, markdown. */
  guide?: string;
  /** The op names an agent that can answer instead (AI Assist). */
  assist_available?: boolean;
  assist?: AssistState | null;
}

/** The field names to draw. An object shape is its keys; anything else is one
 *  unnamed value, which is what a scalar declaration means. */
function fieldsOf(shape: Shape): string[] {
  if (shape && typeof shape === 'object' && !Array.isArray(shape)) return Object.keys(shape);
  return [''];
}

export function AskForm({
  questionId,
  onSettled,
  showOp = true,
}: {
  questionId: string;
  /** Told once the question is answered or cancelled (`'answered'` / `'cancelled'`). */
  onSettled?: (how: 'answered' | 'cancelled') => void;
  /** Show the op's name under the prompt — useful in a bare window, noise inside a wizard. */
  showOp?: boolean;
}) {
  const { _ } = useLingui();
  const [question, setQuestion] = useState<Question | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [settled, setSettled] = useState('');
  const [busy, setBusy] = useState(false);

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
    async (path: '/answer' | '/cancel', body?: unknown) => {
      setBusy(true);
      setError('');
      try {
        await apiClient.post(`/api/v1/ask/${questionId}${path}`, body);
        setSettled(path === '/cancel' ? _(msg`Cancelled.`) : _(msg`Thank you — sent.`));
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

  return (
    <div className="flex flex-col gap-4" data-testid="ask-view">
      <div>
        <h1 className="text-base font-medium" data-testid="ask-prompt">
          {question.prompt}
        </h1>
        {showOp ? <p className="text-xs text-muted-foreground">{question.op}</p> : null}
      </div>

      {question.detail ? (
        <div className="text-sm" data-testid="ask-detail">
          <MarkdownView value={question.detail} compact dataImages />
        </div>
      ) : null}

      {question.guide ? (
        <div className="rounded border bg-muted/30 p-3 text-sm" data-testid="ask-guide">
          <MarkdownView value={question.guide} compact />
        </div>
      ) : null}

      <AskAssist
        questionId={questionId}
        available={question.assist_available}
        initial={question.assist}
        onAnswered={agentAnswered}
      />

      {fieldsOf(question.fields).map((name) => (
        <div key={name} className="flex flex-col gap-1">
          {name ? (
            <label className="text-sm" htmlFor={`ask-${name}`}>
              {name}
            </label>
          ) : null}
          <AskValueInput
            id={`ask-${name}`}
            testId={`ask-input-${name || 'value'}`}
            secret={question.secret}
            file={question.file}
            value={values[name] ?? ''}
            onChange={(value) => setValues((prev) => ({ ...prev, [name]: value }))}
            onEnter={() => void submit()}
          />
        </div>
      ))}

      {error ? (
        <p
          className="rounded border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-foreground"
          data-testid="ask-error"
        >
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button data-testid="ask-submit" disabled={busy} onClick={() => void submit()}>
          <Trans>Send</Trans>
        </Button>
        <Button variant="ghost" data-testid="ask-cancel" disabled={busy} onClick={() => void send('/cancel')}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}
