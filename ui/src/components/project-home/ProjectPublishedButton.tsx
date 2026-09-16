import { useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { PackageCheck } from 'lucide-react';

interface ProjectPublishedButtonProps {
  projectId: string;
}

/**
 * Opens the Discover page for THIS project — what it has published, and what
 * it could still publish. URL-first: the click only navigates; the Discover
 * loader resolves the project from `?scope-project=` (so a hard load, a
 * bookmark and this button all land on the same state).
 */
export function ProjectPublishedButton({ projectId }: ProjectPublishedButtonProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
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
    </Button>
  );
}
