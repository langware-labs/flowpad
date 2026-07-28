import { Check, HelpCircle, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { SETUP_GITHUB_JOURNEY_ID, SetupJourneyButton } from '@src/journey/SetupJourneyButton';
import type { GitCheck } from '@src/components/project-home/ProjectGitChip';

interface ProjectGitChecksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checks: GitCheck[];
  /** Set up Git in the project's own folder — the remedy when the tooling is
   *  fine but this folder has no repo or no remote. */
  onSetupRepo?: () => Promise<void>;
}

/** The one thing to do next, chosen from what actually failed.
 *
 *  Ordered by dependency, not by row order: there is no point offering to
 *  create a remote repository while the tooling that would create it is
 *  missing, so a capability failure always wins.
 */
function nextAction(checks: GitCheck[]): 'github' | 'repo' | null {
  const failed = (id: GitCheck['id']) => checks.find((c) => c.id === id)?.ok === false;
  if (failed('installed') || failed('logged-in')) return 'github';
  if (failed('setup')) return 'repo';
  return null;
}

function CheckMark({ ok }: { ok: boolean | null }) {
  const base = 'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border';
  if (ok === true) {
    return (
      <span className={`${base} border-green-600 bg-green-600 text-white`} aria-label="passed">
        <Check className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  if (ok === false) {
    return (
      <span className={`${base} border-red-500 bg-red-500 text-white`} aria-label="failed">
        <X className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  // Deliberately distinct from a failure: a capability we could not read is not
  // a capability we know to be missing.
  return (
    <span className={`${base} border-border text-muted-foreground`} aria-label="unknown">
      <HelpCircle className="h-3 w-3" aria-hidden />
    </span>
  );
}

/**
 * What Git readiness looks like for this project, and the one thing to do next.
 *
 * Replaces a flat strip of "label — detail" text that stated three findings and
 * offered nothing to do about any of them. Each row is a checklist item so the
 * shape of the answer is readable at a glance; the footer turns whichever
 * failure blocks progress into a single action.
 */
export function ProjectGitChecksDialog({
  open,
  onOpenChange,
  checks,
  onSetupRepo,
}: ProjectGitChecksDialogProps) {
  const [busy, setBusy] = useState(false);
  const action = nextAction(checks);
  const allGood = checks.length > 0 && checks.every((c) => c.ok === true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="project-git-checks-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Git readiness</Trans>
          </DialogTitle>
          <DialogDescription>
            {allGood ? (
              <Trans>This project is ready to publish and share over Git.</Trans>
            ) : (
              <Trans>What Flowpad found when it checked this project's Git setup.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3 py-1" data-testid="project-git-checks-list">
          {checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2.5" data-testid={`git-check-${check.id}`}>
              <span className="mt-0.5">
                <CheckMark ok={check.ok} />
              </span>
              <span className="min-w-0 text-sm">
                <span className={check.ok === false ? 'text-foreground' : 'text-muted-foreground'}>
                  {check.label}
                </span>
                {check.detail && (
                  <span className="block text-xs text-muted-foreground/80">{check.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ul>

        <DialogFooter className="gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {action === 'github' && <Trans>Set up GitHub access first — the rest needs it.</Trans>}
            {action === 'repo' && <Trans>This project's folder needs a repository and a remote.</Trans>}
            {!action && allGood && <Trans>Nothing to do.</Trans>}
          </span>
          <span className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              <Trans>Close</Trans>
            </Button>
            {action === 'github' && (
              <SetupJourneyButton journeyId={SETUP_GITHUB_JOURNEY_ID}>
                <Trans>Set up GitHub</Trans>
              </SetupJourneyButton>
            )}
            {action === 'repo' && onSetupRepo && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                data-testid="project-git-checks-setup-repo"
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  setBusy(true);
                  void onSetupRepo().finally(() => {
                    setBusy(false);
                    onOpenChange(false);
                  });
                }}
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                <Trans>Set up Git</Trans>
              </Button>
            )}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
