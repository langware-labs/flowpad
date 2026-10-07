import { Plural, Trans } from '@lingui/react/macro';
import { KeyRound } from 'lucide-react';
import type { Project } from '@sdk';
import { useProjectSetupLeft } from '@sdk/react/hooks/use-project-readiness';
import { openProjectSetup } from '@src/components/project-setup/project-setup-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { isHubOnly } from '@src/navigation/hub-runtime';

/**
 * "Setup required", glowing beside the project chip while the current project cannot run here
 * yet — the same answer the footer's "Project setup required" warning reads. A click opens the
 * project's setup wizard (a transient overlay, not a navigation). Gone once the project is ready;
 * absent on the hub, which mounts no setup wizard.
 */
export function ProjectSetupButton({ project }: { project?: Project | null }) {
  const left = useProjectSetupLeft(project?.id);
  if (isHubOnly() || !project || !left) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openProjectSetup({ projectId: String(project.id), projectName: project.name ?? '' })}
          data-testid="top-nav-project-setup"
          className="inline-flex h-8 shrink-0 animate-setup-glow items-center gap-1.5 rounded-full border border-yellow-500/60 bg-yellow-500/15 px-3 text-xs font-semibold text-yellow-600 transition-colors hover:bg-yellow-500/25 motion-reduce:animate-none dark:text-yellow-400"
        >
          <KeyRound className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">
            <Trans>Setup required</Trans>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <Plural
          value={left}
          one="# thing to set up before this project can run"
          other="# things to set up before this project can run"
        />
      </TooltipContent>
    </Tooltip>
  );
}
