import React, { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import type { Project } from '@sdk';
import { GitSetupWizard } from '@src/components/git/GitSetupWizard';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';

export interface GitRequiredStripProps {
  /** The project that needs git. Without one there is nothing to set up, so
   *  the strip states the requirement with no button (the hub's cards). */
  project?: Project | null;
  /** Git got set up — the caller carries on with what needed it. */
  onDone?: () => void;
  className?: string;
}

/** "Git is required · Add git" — the one prompt in front of every git need. */
export function GitRequiredStrip({ project, onDone, className }: GitRequiredStripProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs',
        className,
      )}
      data-testid="git-required-strip"
    >
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" aria-hidden />
        <Trans>Git is required</Trans>
      </span>
      {project && (
        <>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setOpen(true)}
            data-testid="git-required-add"
          >
            <Trans>Add git</Trans>
          </Button>
          {open && <GitSetupWizard project={project} open onOpenChange={setOpen} onDone={onDone} />}
        </>
      )}
    </div>
  );
}

export default GitRequiredStrip;
