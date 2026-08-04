import { dataContext, startHelpdeskTicket } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { notify } from '@src/notifications';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans, useLingui } from '@lingui/react/macro';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface HelpdeskRequestDialogProps {
  open: boolean;
  onClose: () => void;
}

// The eleven Flowpad-specific example prompts that used to live here
// ("How to migrate from Lovable", …) were removed rather than translated: this
// dialog is reached from ANY desk's portal, and on a third-party desk those
// chips advertise the wrong product. They belong in the desk's own
// `.flow/customization/string.json`, alongside name/tagline/accent — until
// that lands, no examples beats someone else's examples.

export function HelpdeskRequestDialog({ open, onClose }: HelpdeskRequestDialogProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const ensureCloudLogin = useCloudLoginGate();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setMessage('');
      setBusy(false);
      // Defer focus until the dialog mount/animation completes.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  const canSend = !!message.trim() && !busy;

  const handleSend = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      // Opening a support ticket routes through the hub (the backend resolves
      // the helpdesk project from /version and calls
      // start_guest_conversation), which requires cloud login. Run the OAuth
      // flow first so a logged-out user is taken through sign-in and the send
      // resumes on the same click.
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        console.warn('[HelpdeskRequestDialog] sign in required:', gate.error);
        return;
      }

      let conversationId: string;
      try {
        const res = await startHelpdeskTicket(message.trim(), dataContext.project?.id);
        conversationId = res.conversation_id;
      } catch (err) {
        console.error('[HelpdeskRequestDialog] failed to open support ticket', err);
        notify.error({
          title: t`Could not reach support`,
          message: errorMessage(err, t`The help desk is unavailable right now. Please try again.`),
        });
        return;
      }

      navigation.openDock(DockPointer.forConversation(conversationId));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg" data-testid="helpdesk-request-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[hsl(var(--brand))]" />
            <Trans>What do you need help with?</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            <Trans>
              Send a question to the help desk. A new conversation will open with your message as the
              starting point.
            </Trans>
          </p>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t`Describe what you need — what happened, what you expected, and anything you have already tried.`}
            rows={6}
            disabled={busy}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="helpdesk-request-input"
          />
          <p className="text-[11px] text-muted-foreground/80">
            <Trans>⌘/Ctrl + Enter to send</Trans>
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="bg-[hsl(var(--brand))] text-[hsl(var(--brand-foreground))] hover:bg-[hsl(var(--brand))]/90"
          >
            {busy ? t`Sending…` : t`Send`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
