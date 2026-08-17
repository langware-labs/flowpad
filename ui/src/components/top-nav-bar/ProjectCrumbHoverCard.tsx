import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ExternalLink } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { WikiButton } from '@src/components/wiki-tip/WikiButton';
import { useProjectLocation } from '@src/hooks/use-project-location';
import { CopyPathButton } from './CopyPathButton';

/** Project identity and filesystem utilities behind the leading address crumb. */
export function ProjectCrumbHoverCard({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const { project, computeNode, projectPath, openProjectFolder } = useProjectLocation();

  if (!project) return children;

  const openFolderLabel = t`Open folder: ${projectPath}`;

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        className="w-96 p-3"
        data-testid="top-nav-project-details"
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={project.displayName}>
            {project.displayName}
          </div>
          <WikiButton wikiword="Flowpad project" label={t`What is a Flowpad project?`} />
        </div>

        {projectPath && (
          <div className="mt-1.5 flex items-center gap-1">
            <CopyPathButton path={projectPath} testId="top-nav-project-copy-path" className="min-w-0 flex-1" />
            {computeNode && (
              <button
                type="button"
                onClick={() => void openProjectFolder()}
                title={openFolderLabel}
                aria-label={openFolderLabel}
                data-testid="top-nav-project-open-folder"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-primary"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
