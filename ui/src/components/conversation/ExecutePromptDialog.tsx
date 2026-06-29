import { useState } from 'react';
import { Play } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PermissionAction } from '@sdk';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import {
  grantContactPermission,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';

interface ExecutePromptDialogProps {
  open: boolean;
  onClose: () => void;
  /** The contact who sent the prompt — keys the persisted permissions. */
  contact: ContactKey & { name?: string | null };
  /** The conversation's mapped project (null = unmapped → project options off). */
  projectId: string | null;
  /** Run the prompt on the backend with the resolved auto-reply flag. */
  onExecute: (autoReply: boolean) => Promise<void> | void;
}

/**
 * Confirm dialog for executing a received prompt. Beyond running it now, the
 * checkboxes persist `ContactPermission` rows so future prompts from this
 * contact auto-run (and optionally auto-reply) — the receiver's local policy.
 * "Just this message" is a one-shot auto-reply (not persisted).
 */
export function ExecutePromptDialog({
  open,
  onClose,
  contact,
  projectId,
  onExecute,
}: ExecutePromptDialogProps) {
  const { t } = useLingui();
  const who = contact.name?.trim() || contact.email?.trim() || 'this contact';
  const hasProject = !!projectId;

  const [autorunProject, setAutorunProject] = useState(false);
  const [autorunGlobal, setAutorunGlobal] = useState(false);
  const [replyProject, setReplyProject] = useState(false);
  const [replyGlobal, setReplyGlobal] = useState(false);
  const [replyOnce, setReplyOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  // No reset effect needed: the parent renders this dialog only while a target
  // is set, so it remounts fresh each open and the useState defaults apply.

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const c: ContactKey = { userId: contact.userId, email: contact.email };
      if (autorunGlobal) await grantContactPermission(c, null, PermissionAction.EXECUTE_PROMPT);
      if (autorunProject && projectId) {
        await grantContactPermission(c, projectId, PermissionAction.EXECUTE_PROMPT);
      }
      if (replyGlobal) await grantContactPermission(c, null, PermissionAction.AUTO_REPLY);
      if (replyProject && projectId) {
        await grantContactPermission(c, projectId, PermissionAction.AUTO_REPLY);
      }
      const autoReply = replyGlobal || replyProject || replyOnce;
      await onExecute(autoReply);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="execute-prompt-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4 text-primary" />
            <Trans>Execute prompt from {who}</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            <Trans>Run this prompt in the shared session now. Optionally let future prompts from {who} run automatically.</Trans>
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Auto-run future prompts</Trans>
            </legend>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={autorunProject}
                onCheckedChange={(v) => setAutorunProject(!!v)}
                disabled={!hasProject}
                data-testid="perm-autorun-project"
              />
              <span className={hasProject ? '' : 'text-muted-foreground'}>
                <Trans>Auto-run prompts from {who} for this project</Trans>
              </span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={autorunGlobal}
                onCheckedChange={(v) => setAutorunGlobal(!!v)}
                data-testid="perm-autorun-global"
              />
              <span><Trans>Auto-run prompts from {who} (all projects)</Trans></span>
            </label>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Auto-reply</Trans>
            </legend>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={replyOnce}
                onCheckedChange={(v) => setReplyOnce(!!v)}
                data-testid="perm-reply-once"
              />
              <span><Trans>Send the reply for just this message</Trans></span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={replyProject}
                onCheckedChange={(v) => setReplyProject(!!v)}
                disabled={!hasProject}
                data-testid="perm-reply-project"
              />
              <span className={hasProject ? '' : 'text-muted-foreground'}>
                <Trans>Always auto-reply to {who} for this project</Trans>
              </span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={replyGlobal}
                onCheckedChange={(v) => setReplyGlobal(!!v)}
                data-testid="perm-reply-global"
              />
              <span><Trans>Always auto-reply to {who} (all projects)</Trans></span>
            </label>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t`Cancel`}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy} data-testid="execute-prompt-confirm" className="gap-1.5">
            <Play className="h-4 w-4" />
            {busy ? t`Running…` : t`Execute`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
