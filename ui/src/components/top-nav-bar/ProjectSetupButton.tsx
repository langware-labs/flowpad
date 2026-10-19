import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { KeyRound } from 'lucide-react';
import type { Project } from '@sdk';
import { useProjectSetupLeft } from '@sdk/react/hooks/use-project-readiness';
import { openProjectSetup } from '@src/components/project-setup/project-setup-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { isHubOnly } from '@src/navigation/hub-runtime';

/**
 * A single round glowing key beside the project chip while the current project cannot run here
 * yet — the same answer the footer's "Project setup required" warning reads. The tooltip carries
 * the label and the count of things left; the button itself stays icon-only. A click opens the
 * project's setup wizard (a transient overlay, not a navigation). Gone once the project is ready;
 * absent on the hub, which mounts no setup wizard.
 */
export function ProjectSetupButton({ project }: { project?: Project | null }) {
  const { t } = useLingui();
  const left = useProjectSetupLeft(project?.id);
  if (isHubOnly() || !project || !left) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openProjectSetup({ projectId: String(project.id), projectName: project.name ?? '' })}
          data-testid="top-nav-project-setup"
          aria-label={t`Setup required`}
          className="inline-flex h-8 w-8 shrink-0 animate-setup-glow items-center justify-center rounded-full border border-yellow-500/60 bg-yellow-500/15 text-yellow-600 transition-colors hover:bg-yellow-500/25 motion-reduce:animate-none dark:text-yellow-400"
        >
          <KeyRound className="h-4 w-4 shrink-0" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="font-semibold">
          <Trans>Setup required</Trans>
        </div>
        <Plural
          value={left}
          one="# thing to set up before this project can run"
          other="# things to set up before this project can run"
        />
      </TooltipContent>
    </Tooltip>
  );
}
