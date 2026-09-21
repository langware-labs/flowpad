import { useCallback, useEffect, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import apiClient from '@sdk/client';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';

/**
 * A question a ComputeOp put to a person.
 *
 * Drawn in `win/`, where the routed view IS the window — so this renders the
 * whole surface and nothing around it. The fields come from the op's declared
 * `output`, not from a hand-written list, so an op that declares a new field
 * grows one here with no change to this component.
 *
 * The op on the other end is waiting with a deadline. That shapes two things:
 * Cancel is a first-class answer rather than a way to close the window, and a
 * question that has already settled renders as settled instead of as a form
 * nobody is listening to.
 */

type Shape = Record<string, unknown> | string | null;

interface Question {
  id: string;
  op: string;
  prompt: string;
  shape: Shape;
}

/** The field names to draw. An object shape is its keys; anything else is one
 *  unnamed value, which is what a scalar declaration means. */
function fieldsOf(shape: Shape): string[] {
  if (shape && typeof shape === 'object' && !Array.isArray(shape)) return Object.keys(shape);
  return [''];
}

export default function AskView() {
  const { _ } = useLingui();
  // The pointer comes from the parsed dock address, not from a route param:
  // the route is `:viewType/*`, so react-router never names this segment.
  const { currentDock } = useDockNavigation();
  const questionId = currentDock?.pointer;
  const [question, setQuestion] = useState<Question | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [settled, setSettled] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!questionId) return;
    let alive = true;
    void (async () => {
      const res = await apiClient.get<Question>(`/api/v1/ask/${questionId}`).catch(() => null);
      if (!alive) return;
      // A question that is gone is the NORMAL end: the op timed out, or someone
      // else answered. Say so rather than showing a form that resolves nothing.
      if (!res) setSettled(_(msg`This question is no longer waiting.`));
      else setQuestion(res as Question);
    })();
    return () => {
      alive = false;
    };
  }, [questionId, _]);

  const send = useCallback(
    async (path: string, body?: unknown) => {
      if (!questionId) return;
      setBusy(true);
      setError('');
      try {
        await apiClient.post(`/api/v1/ask/${questionId}${path}`, body);
        setSettled(path === '/cancel' ? _(msg`Cancelled.`) : _(msg`Thank you — sent.`));
      } catch (reason) {
        // A 422 means the value did not match the shape the op declared. The
        // question is still open, so this is correctable in place.
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [questionId, _],
  );

  const submit = useCallback(() => {
    const names = fieldsOf(question?.shape ?? null);
    const value =
      names.length === 1 && names[0] === ''
        ? values['']
        : Object.fromEntries(names.map((n) => [n, values[n] ?? '']));
    return send('/answer', { value });
  }, [question, values, send]);

  if (settled) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="ask-settled">
        <p className="text-sm text-muted-foreground">{settled}</p>
      </div>
    );
  }
  if (!question) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6" data-testid="ask-view">
      <div>
        <h1 className="text-base font-medium" data-testid="ask-prompt">
          {question.prompt}
        </h1>
        <p className="text-xs text-muted-foreground">{question.op}</p>
      </div>

      {fieldsOf(question.shape).map((name) => (
        <div key={name} className="flex flex-col gap-1">
          {name ? (
            <label className="text-sm" htmlFor={`ask-${name}`}>
              {name}
            </label>
          ) : null}
          <Input
            id={`ask-${name}`}
            data-testid={`ask-input-${name || 'value'}`}
            autoFocus
            value={values[name] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </div>
      ))}

      {error ? (
        <p className="text-sm text-destructive" data-testid="ask-error">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button data-testid="ask-submit" disabled={busy} onClick={() => void submit()}>
          <Trans>Send</Trans>
        </Button>
        <Button
          variant="ghost"
          data-testid="ask-cancel"
          disabled={busy}
          onClick={() => void send('/cancel')}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}
