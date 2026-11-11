import { Check, HelpCircle, X } from 'lucide-react';
import type { Project } from '@sdk';
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
import { SETUP_GITHUB_JOURNEY, SetupJourneyButton } from '@src/journey/SetupJourneyButton';
import type { GitCheck } from '@src/components/project-home/ProjectGitChip';
import { GitRequiredStrip } from '@src/components/git/GitRequiredStrip';

interface ProjectGitChecksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checks: GitCheck[];
  /** The project whose folder gets git — the "Add git" strip's target when
   *  this folder has no repo or no remote. */
  project?: Project | null;
}

/** The fix for ONE step, rendered on the row it repairs.
 *
 *  Only a definite failure gets a button: `ok === null` is a check we could not
 *  read, not one we know to be missing, and offering to "fix" it would send the
 *  user somewhere they may not need to go.
 *
 *  Both capability rows launch the setup-github journey — it installs the CLI
 *  and signs in — but each is labelled for its own step, because a row reading
 *  "Signed in to the remote ✗ [Install gh]" would name the wrong problem.
 */
function RowFix({ check }: { check: GitCheck }) {
  if (check.ok !== false) return null;
  switch (check.id) {
    case 'installed':
      return (
        <SetupJourneyButton journey={SETUP_GITHUB_JOURNEY}>
          <Trans>Install gh</Trans>
        </SetupJourneyButton>
      );
    case 'logged-in':
      return (
        <SetupJourneyButton journey={SETUP_GITHUB_JOURNEY}>
          <Trans>Sign in</Trans>
        </SetupJourneyButton>
      );
    case 'setup':
      // Owned by the "Git is required" strip under the list.
      return null;
  }
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

/** Git readiness for this project as a checklist, each failing row carrying the
 *  fix for its own step. */
export function ProjectGitChecksDialog({ open, onOpenChange, checks, project }: ProjectGitChecksDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="project-git-checks-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Git readiness</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>What Flowpad found when it checked this project's Git setup.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3 py-1" data-testid="project-git-checks-list">
          {checks.map((check) => (
            <li key={check.id} className="flex items-start justify-between gap-3" data-testid={`git-check-${check.id}`}>
              <span className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5">
                  <CheckMark ok={check.ok} />
                </span>
                <span className="min-w-0 text-sm">
                  <span className={check.ok === false ? 'text-foreground' : 'text-muted-foreground'}>
                    {check.label}
                  </span>
                  {check.detail && <span className="block text-xs text-muted-foreground/80">{check.detail}</span>}
                </span>
              </span>
              <RowFix check={check} />
            </li>
          ))}
        </ul>

        {project?.fs_storage_mount_path && checks.some((c) => c.id === 'setup' && c.ok === false) && (
          <GitRequiredStrip project={project} onDone={() => onOpenChange(false)} />
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
