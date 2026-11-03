import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { KeyRound } from 'lucide-react';
import type { Project } from '@sdk';
import { useProjectSetupLeft, useProjectUpdatesPending } from '@sdk/react/hooks/use-project-readiness';
import { openProjectSetup } from '@src/components/project-setup/project-setup-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { cn } from '@src/lib/utils';

/**
 * A single round glowing key beside the project chip while the current project cannot run here
 * yet — the same answer the footer's "Project setup required" warning reads — or while dependencies
 * Flowpad cloned have updates waiting. Yellow means setup is owed; blue means only updates are
 * waiting; yellow with a blue dot means both. The tooltip carries the label and the counts; the
 * button itself stays icon-only. A click opens the project's setup dialog (a transient overlay, not a
 * navigation), where updates are pulled. Gone once nothing is owed or waiting; absent on the hub,
 * which mounts no setup dialog.
 */
export function ProjectSetupButton({ project }: { project?: Project | null }) {
  const { t } = useLingui();
  const left = useProjectSetupLeft(project?.id);
  const updates = useProjectUpdatesPending(project?.id);
  if (isHubOnly() || !project || (!left && !updates)) return null;
  const onlyUpdates = !left;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openProjectSetup({ projectId: String(project.id), projectName: project.name ?? '' })}
          data-testid="top-nav-project-setup"
          data-updates={updates || undefined}
          aria-label={onlyUpdates ? t`Dependency updates available` : t`Setup required`}
          className={cn(
            'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors motion-reduce:animate-none',
            onlyUpdates
              ? 'animate-updates-glow border-blue-500/60 bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 dark:text-blue-400'
              : 'animate-setup-glow border-yellow-500/60 bg-yellow-500/15 text-yellow-600 hover:bg-yellow-500/25 dark:text-yellow-400',
          )}
        >
          <KeyRound className="h-4 w-4 shrink-0" />
          {left > 0 && updates > 0 && (
            <span
              data-testid="top-nav-project-updates-dot"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-background"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {left > 0 && (
          <>
            <div className="font-semibold">
              <Trans>Setup required</Trans>
            </div>
            <Plural
              value={left}
              one="# thing to set up before this project can run"
              other="# things to set up before this project can run"
            />
          </>
        )}
        {updates > 0 && (
          <div className={cn(left > 0 ? 'mt-1' : 'font-semibold')}>
            <Plural value={updates} one="# dependency has updates" other="# dependencies have updates" />
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
