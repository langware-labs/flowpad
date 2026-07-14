import { useState, type ReactNode } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PermissionAction } from '@sdk';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@src/components/ui/collapsible';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { WikiLabel } from '@src/components/wiki-tip';
import {
  grantContactPermission,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';

/** The built-in wiki page the "Learn more" links resolve to (by title). */
const PROMPT_EXECUTION_WIKI = 'Prompt execution';

/** "Learn more" link into the Prompt execution wiki page, optionally to a section. */
function LearnMore({ fragment }: { fragment?: string }) {
  const { t } = useLingui();
  return <WikiLabel wikiword={PROMPT_EXECUTION_WIKI} label={t`Learn more`} fragment={fragment} />;
}

/** A single permission checkbox row. Project-scoped rows are disabled + muted
 *  when the conversation has no mapped project. */
function PermRow({
  checked,
  onChange,
  testId,
  hasProject,
  projectScoped,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
  hasProject: boolean;
  projectScoped?: boolean;
  children: ReactNode;
}) {
  const muted = !!projectScoped && !hasProject;
  return (
    <label className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(!!v)}
        disabled={muted}
        data-testid={testId}
      />
      <span className={muted ? 'text-muted-foreground' : ''}>{children}</span>
    </label>
  );
}

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // No reset effect needed: the parent renders this dialog only while a target
  // is set, so it remounts fresh each open and the useState defaults apply.

  // The simple "Don't ask again" checkbox is an alias for auto-running future
  // prompts from this contact: scoped to the project when the conversation has
  // one (most conservative), else global. It shares state with the matching
  // Advanced row, so there is a single source of truth.
  const dontAskAgain = hasProject ? autorunProject : autorunGlobal;
  const setDontAskAgain = (v: boolean) =>
    hasProject ? setAutorunProject(v) : setAutorunGlobal(v);

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
            <Trans>Allow {who} to run prompt on this computer</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          {/* Primary decision: run now, optionally stop asking. "Don't ask
              again" aliases the project-scoped auto-run permission. */}
          <label className="flex items-center gap-2">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(v) => setDontAskAgain(!!v)}
              data-testid="perm-dont-ask-again"
            />
            <span><Trans>Don't ask again</Trans></span>
          </label>

          <p className="text-xs text-muted-foreground">
            <Trans>Never run prompts from untrusted sources.</Trans>{' '}
            <LearnMore />
          </p>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                data-testid="execute-prompt-advanced-toggle"
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
                />
                <Trans>Advanced</Trans>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Auto-run future prompts</Trans>
                  <LearnMore fragment="auto-run" />
                </legend>
                <PermRow checked={autorunProject} onChange={setAutorunProject} hasProject={hasProject} projectScoped testId="perm-autorun-project">
                  <Trans>Auto-run prompts from {who} for this project</Trans>
                </PermRow>
                <PermRow checked={autorunGlobal} onChange={setAutorunGlobal} hasProject={hasProject} testId="perm-autorun-global">
                  <Trans>Auto-run prompts from {who} (all projects)</Trans>
                </PermRow>
              </fieldset>

              <fieldset className="flex flex-col gap-2">
                <legend className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Auto-reply</Trans>
                  <LearnMore fragment="auto-reply" />
                </legend>
                <PermRow checked={replyOnce} onChange={setReplyOnce} hasProject={hasProject} testId="perm-reply-once">
                  <Trans>Send the reply for just this message</Trans>
                </PermRow>
                <PermRow checked={replyProject} onChange={setReplyProject} hasProject={hasProject} projectScoped testId="perm-reply-project">
                  <Trans>Always auto-reply to {who} for this project</Trans>
                </PermRow>
                <PermRow checked={replyGlobal} onChange={setReplyGlobal} hasProject={hasProject} testId="perm-reply-global">
                  <Trans>Always auto-reply to {who} (all projects)</Trans>
                </PermRow>
              </fieldset>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t`Cancel`}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy} data-testid="execute-prompt-confirm" className="gap-1.5">
            <Play className="h-4 w-4" />
            {busy ? t`Running…` : t`Allow`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
