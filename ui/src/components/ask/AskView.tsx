import { useCallback } from 'react';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { getHistoryPosition } from '@src/navigation/history-position-store';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { fieldsOf, useAskQuestion } from './use-ask-question';

/**
 * A question a ComputeOp put to a person — the full-page rendering, at
 * `/dock/ask/<id>`.
 *
 * Two homes. In `win/` (the chrome-less window opened when no tab was
 * listening) this is the whole window and settles on a message, since there
 * is nothing to go back to — that is the ONE case this page still exists for.
 * A live tab gets `AskModal` instead (a dialog over whatever it was already
 * showing); this page and that modal are two thin renderings of the same
 * `useAskQuestion` hook, never two copies of the logic.
 *
 * The op on the other end is waiting with a deadline. That shapes two things:
 * Cancel is a first-class answer rather than a way to close the window, and a
 * question that has already settled renders as settled instead of as a form
 * nobody is listening to.
 */
export default function AskView() {
  // The pointer comes from the parsed dock address, not from a route param:
  // the route is `:viewType/*`, so react-router never names this segment.
  const { navigation, currentDock, windowMode } = useDockNavigation();
  const questionId = currentDock?.pointer;
  const {
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
  } = useAskQuestion(questionId);

  // Leave the question. It was pushed over whatever the person was doing, so in
  // the dock the way out is back to it — or home when this tab has no history
  // (a fresh load straight onto the question). Never a dead-end message: that
  // used to strand people until they restarted the app.
  const leave = useCallback(() => {
    if (getHistoryPosition().canGoBack) navigation.goBack();
    else navigation.goHome();
  }, [navigation]);

  if (settledKind) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6" data-testid="ask-settled">
        {settledMessage && <p className="text-sm text-muted-foreground">{settledMessage}</p>}
        {wizardId && runningNow && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-wizard-live">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>{runningNow.current || runningNow.label || runningNow.name}</span>
          </p>
        )}
        {wizardId && (
          <Button data-testid="ask-see-wizard" onClick={openWizard}>
            <Trans>See setup progress</Trans>
          </Button>
        )}
        {windowMode ? null : (
          <Button variant="ghost" data-testid="ask-back" onClick={leave}>
            <Trans>Back</Trans>
          </Button>
        )}
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
    <div className="flex h-full items-center justify-center p-6" data-testid="ask-view">
      <div className="flex w-full max-w-md flex-col gap-4">
        <div>
          <h1 className="text-base font-medium" data-testid="ask-prompt">
            {question.prompt}
          </h1>
          {question.detail ? (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="ask-detail">
              {question.detail}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{question.op}</p>
          )}
          {wizardId && (
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground underline underline-offset-2"
              data-testid="ask-wizard-link"
              onClick={openWizard}
            >
              <Trans>Part of a setup — see its progress</Trans>
            </button>
          )}
        </div>

        {fieldsOf(question.fields).map((name) => (
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
              type={question.secret ? 'password' : 'text'}
              autoComplete={question.secret ? 'off' : undefined}
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
            {question.submit_label || <Trans>Send</Trans>}
          </Button>
          <Button variant="ghost" data-testid="ask-cancel" disabled={busy} onClick={() => void cancel()}>
            {question.cancel_label || <Trans>Cancel</Trans>}
          </Button>
        </div>
      </div>
    </div>
  );
}
