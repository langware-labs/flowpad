import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';

export interface SendOnceDoneAnswer {
  send: boolean;
  /** Make this answer the "Send report once done" default. */
  remember: boolean;
  /** Stop asking (the checkbox decides from now on). */
  dontShowAgain: boolean;
}

interface SendOnceDoneDialogProps {
  open: boolean;
  /** Who the results would go to ("Eran Shlomo and the help desk"). */
  to: string;
  onAnswer: (answer: SendOnceDoneAnswer) => void;
  onCancel: () => void;
}

/**
 * Asked at Diagnose — not at the finish, when the window is usually long closed — when people are
 * picked and "Send report once done" is off.
 */
export function SendOnceDoneDialog({ open, to, onAnswer, onCancel }: SendOnceDoneDialogProps) {
  const { t } = useLingui();
  const [remember, setRemember] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const answer = (send: boolean) => onAnswer({ send, remember, dontShowAgain });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm" data-testid="diagnose-send-once-done-dialog">
        <DialogHeader>
          <DialogTitle>{t`Send report once done?`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            <Trans>
              When the diagnosis finishes, Flowpad sends the results to{' '}
              <span className="font-medium text-foreground">{to}</span> in a new conversation — even if you close this
              window.
            </Trans>
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                data-testid="diagnose-ask-remember"
              />
              {t`Remember this decision`}
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                data-testid="diagnose-ask-dont-show"
              />
              {t`Don't show again`}
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(false)}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50"
              data-testid="diagnose-ask-dont-send"
            >
              {t`Don't send`}
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              data-testid="diagnose-ask-send"
            >
              {t`Send when done`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an answer writes to the two preferences — pure, so it is tested without a dialog.
 * "Remember" sets the checkbox default to this answer; "Don't show again" stops the question.
 */
export function prefsAfterAnswer(answer: SendOnceDoneAnswer): {
  sendWhenDone?: boolean;
  askBeforeSend?: boolean;
} {
  return {
    ...(answer.remember ? { sendWhenDone: answer.send } : {}),
    ...(answer.dontShowAgain ? { askBeforeSend: false } : {}),
  };
}

/** Whether Diagnose asks first: people picked, the box off, and the question not turned off. */
export function shouldAsk(picked: number, sendWhenDone: boolean, askBeforeSend: boolean): boolean {
  return picked > 0 && !sendWhenDone && askBeforeSend;
}
