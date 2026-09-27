import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useAskModalStore } from './ask-modal-store';
import { fieldsOf, useAskQuestion } from './use-ask-question';

/**
 * A question a ComputeOp put to a person — the MODAL rendering, opened by the
 * `open_ask_modal` ui_command over whatever a live tab is already showing. If
 * that happens to be a wizard's own progress page, it stays visible right
 * behind this dialog; answering or cancelling just closes it, since nothing
 * was ever navigated away from. The no-live-tab fallback (a fresh `win/`
 * window) still gets the full-page `AskView` instead — there is no screen
 * behind it there to leave visible.
 */
export function AskModalRoot() {
  const open = useAskModalStore((s) => s.open);
  const questionId = useAskModalStore((s) => s.payload);
  const setOpen = useAskModalStore((s) => s.setOpen);
  if (!open || !questionId) return null;
  return <AskModal questionId={questionId} onOpenChange={setOpen} />;
}

function AskModal({ questionId, onOpenChange }: { questionId: string; onOpenChange: (open: boolean) => void }) {
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

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="ask-modal">
        {settledKind ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="ask-modal-settled">
            {settledMessage && <p className="text-sm text-muted-foreground">{settledMessage}</p>}
            {wizardId && runningNow && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-modal-live">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                <span>{runningNow.current || runningNow.label || runningNow.name}</span>
              </p>
            )}
            <div className="mt-1 flex gap-2">
              {wizardId && (
                <Button
                  data-testid="ask-modal-see-wizard"
                  onClick={() => {
                    onOpenChange(false);
                    openWizard();
                  }}
                >
                  <Trans>See setup progress</Trans>
                </Button>
              )}
              <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="ask-modal-close">
                <Trans>Close</Trans>
              </Button>
            </div>
          </div>
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
