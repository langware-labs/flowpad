import { useMemo } from 'react';
import { Project, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { Trans } from '@lingui/react/macro';
import { LifeBuoy } from 'lucide-react';
import { HelpdeskAsk } from './HelpdeskAsk';
import { HelpdeskArticle } from './HelpdeskArticle';
import { HelpdeskGuides } from './HelpdeskGuides';
import { HelpdeskMyItems } from './HelpdeskMyItems';
import { HelpdeskBrandHeader } from './HelpdeskBrandHeader';
import { useHelpdeskBrand } from './useHelpdeskBrand';

/**
 * The helpdesk portal — the landing for `ViewType.HELPDESK`.
 *
 * Replaces the generic project home, which offered a requester an authoring
 * surface (session tiles, asset tiles, Secrets) for a project they do not own.
 *
 * Order is deliberate: **ask**, then **your questions**, then **the guides**.
 * The usual advice is search-first with escalation below the fold, but a
 * conversational agent is both — it answers from the guides and hands off — so
 * it earns the top slot. Everything reads its identity from the URL
 * (`currentDock`), never from ambient state.
 */
export function HelpdeskPortalPage() {
  const { currentDock } = useDockNavigation();
  const { projectId, articlePath } = useMemo(
    () => DockPointer.parseHelpdeskPointer(currentDock?.pointer),
    [currentDock?.pointer],
  );

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);
  const brand = useHelpdeskBrand(project);

  if (!projectId || !project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <LifeBuoy className="h-6 w-6" />
        <p className="text-sm">
          <Trans>The help desk is not set up on this machine yet.</Trans>
        </p>
      </div>
    );
  }

  return (
    // The accent is applied HERE, not on documentElement — one desk's brand
    // must not leak into the rest of the app. See `useHelpdeskBrand`.
    <div className="flex h-full min-h-0 flex-col" style={brand.accentStyle} data-testid="helpdesk-portal">
      <HelpdeskBrandHeader brand={brand} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pb-12 pt-6">
          {articlePath ? (
            <HelpdeskArticle projectId={projectId} projectTypeId={projectTypeId} articlePath={articlePath} />
          ) : (
            <>
              <HelpdeskAsk project={project} />
              <HelpdeskMyItems />
              <HelpdeskGuides projectId={projectId} mountPath={project.fs_storage_mount_path} />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
