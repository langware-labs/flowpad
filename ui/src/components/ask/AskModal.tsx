import { useCallback, useEffect } from 'react';
import { Trans } from '@lingui/react/macro';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Button } from '@src/components/ui/button';
import { MarkdownView } from '@src/components/markdown-view';
import { useAskModalStore } from './ask-modal-store';
import { fieldsOf, useAskQuestion } from './use-ask-question';

/**
 * A question a ComputeOp put to a person — the MODAL rendering, opened by the
 * `open_ask_modal` ui_command over whatever a live tab is already showing. If
 * that happens to be a wizard's own progress page, it stays visible right
 * behind this dialog — which is exactly why, unlike the full-page `AskView`,
 * this one carries NO wizard-specific link or status of its own: closing (or
 * auto-closing, once settled) is enough to see it, since nothing was ever
 * navigated away from. The no-live-tab fallback (a fresh `win/` window) still
 * gets `AskView` instead — there is no screen behind it there to reveal.
 */
export function AskModalRoot() {
  const open = useAskModalStore((s) => s.open);
  const questionId = useAskModalStore((s) => s.payload);
  const setOpen = useAskModalStore((s) => s.setOpen);
  if (!open || !questionId) return null;
  return <AskModal questionId={questionId} onOpenChange={setOpen} />;
}

function AskModal({ questionId, onOpenChange }: { questionId: string; onOpenChange: (open: boolean) => void }) {
  const { question, values, setValues, error, busy, settledKind, settledMessage, submit, cancel } =
    useAskQuestion(questionId);

  // Settled, however it got there: nothing left for THIS dialog to say — the
  // page it was sitting over (a wizard's own progress view, or anything else)
  // is already the answer to "what happens now", and it is right there the
  // instant this closes.
  useEffect(() => {
    if (settledKind) onOpenChange(false);
  }, [settledKind, onOpenChange]);

  // Esc / a click outside is the person's "no", never just a hidden dialog: an
  // `until_answered` ask has no deadline, so a question dismissed without
  // answering would hold its wizard (and its run slot) until the backend
  // restarts, with nothing left on screen to answer it. Cancelling settles it,
  // and the effect above closes the dialog.
  const dismiss = useCallback(
    (next: boolean) => {
      if (next) return;
      if (settledKind) onOpenChange(false);
      else if (!busy) void cancel();
    },
    [settledKind, busy, cancel, onOpenChange],
  );

  return (
    <Dialog open onOpenChange={dismiss}>
      {/* Above every other dialog (z-50), by z-index rather than by mount order: the
          wizard's own popup can re-mount after a question arrives, and a question
          hidden behind the very popup that raised it cannot be answered. */}
      <DialogContent className="z-[60] sm:max-w-md" overlayClassName="z-[60]" data-testid="ask-modal">
        {settledKind ? (
          settledMessage && (
            <p className="py-2 text-center text-sm text-muted-foreground" data-testid="ask-modal-settled">
              {settledMessage}
            </p>
          )
        ) : !question ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle data-testid="ask-modal-prompt">{question.prompt}</DialogTitle>
              {question.detail ? (
                <DialogDescription data-testid="ask-modal-detail">{question.detail}</DialogDescription>
              ) : null}
            </DialogHeader>

            {/* The guide is `setup.md` — genuinely helpful beside a field asking
                for a value ("copy the Phone number ID"), and pure noise beside a
                plain yes/no confirm, which has nothing to guide anyone THROUGH
                and whose `setup.md` is written for the next maintainer, not for
                whoever is answering. */}
            {question.guide && fieldsOf(question.fields).length > 0 ? (
              <div className="rounded border bg-muted/30 p-3 text-sm" data-testid="ask-modal-guide">
                <MarkdownView value={question.guide} compact />
              </div>
            ) : null}

            {fieldsOf(question.fields).map((name) => (
              <div key={name} className="flex flex-col gap-1">
                {name ? (
                  <label className="text-sm" htmlFor={`ask-modal-${name}`}>
                    {name}
                  </label>
                ) : null}
                <Input
                  id={`ask-modal-${name}`}
                  data-testid={`ask-modal-input-${name || 'value'}`}
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
              <p className="text-sm text-destructive" data-testid="ask-modal-error">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => void cancel()} data-testid="ask-modal-cancel">
                {question.cancel_label || <Trans>Cancel</Trans>}
              </Button>
              <Button disabled={busy} onClick={() => void submit()} data-testid="ask-modal-submit">
                {question.submit_label || <Trans>Send</Trans>}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
