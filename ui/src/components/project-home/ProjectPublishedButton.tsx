import { useLingui } from '@lingui/react/macro';
import { dataManager, EntityTypes, Project, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { PackageCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

interface ProjectPublishedButtonProps {
  projectId: string;
}

/**
 * Opens the Discover page for THIS project — what it has published. It shows
 * how many assets that is, and is not shown at all while there are none: a
 * bare "Published" read as a status of the project. URL-first: the click only
 * navigates; the Discover loader resolves the project from `?scope-project=`.
 */
export function ProjectPublishedButton({ projectId }: ProjectPublishedButtonProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const count = usePublishedCount(projectId);
  if (!count) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => navigation.openDiscover(projectId)}
      title={t`Published assets of this project`}
      data-testid="project-published"
    >
      <PackageCheck className="h-3.5 w-3.5" />
      {t`Published`}
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </Button>
  );
}

/** How many assets the project's manifest publishes; 0 while loading or on error. */
function usePublishedCount(projectId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    setCount(0);
    void (async () => {
      try {
        const project = await dataManager.getByTypeId<Project>(new TypeId(EntityTypes.Project, projectId));
        const view = project ? await project.getPublished() : null;
        if (live) setCount(view?.rows?.length ?? 0);
      } catch {
        // No count: the button stays hidden.
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId]);
  return count;
}
