import { Trans } from '@lingui/react/macro';
import { useHostedRepo } from '@src/hooks/use-hosted-repo';
import { hubProjectGitDock } from '@src/lib/hub-page-url';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { GitBranch } from 'lucide-react';

/** Hub project header: opens the project's Git view. Shown only when the project has a hosted repo. */
export function ProjectGitButton({ projectId }: { projectId: string }) {
  const { navigation } = useDockNavigation();
  const repo = useHostedRepo(projectId);
  if (!repo.data) return null;
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold shadow-sm transition-colors hover:bg-accent"
      data-testid="project-git-button"
      onClick={() => navigation.openDock(hubProjectGitDock(projectId))}
    >
      <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
      <Trans>Git</Trans>
    </button>
  );
}
