import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionInfo, dataManager, Project, TypeId } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { useMarkdownAssetComponents } from '@src/components/use-markdown-asset-components';
import { Button } from '@src/components/ui/button';
import { Skeleton } from '@src/components/ui/skeleton';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { errorMessage } from '@src/lib/error-message';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft } from 'lucide-react';

/**
 * One guide from the portal repo.
 *
 * The body is fetched with the generic `fs` download action against the PORTAL
 * PROJECT — the same pattern `DocsViewer` uses, minus its AgenticProcess
 * coupling. The action is registered with `@action.all` and resolves storage
 * from the entity's own mount path, so this needs no backend change.
 *
 * Relative images and inter-article links are resolved through
 * `useMarkdownAssetComponents`; without it a screenshot 404s and a link opens a
 * blank tab.
 */
export function HelpdeskArticle({ project, articlePath }: { project: Project; articlePath: string }) {
  const { navigation } = useDockNavigation();
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectTypeId = useMemo(
    () => (project.id ? new TypeId(Project.type, project.id) : null),
    [project.id],
  );

  const onNavigate = useCallback(
    (resolvedPath: string) => {
      // In-repo links stay in the portal, URL-first.
      navigation.openDock(DockPointer.forHelpdesk(project.id, resolvedPath));
    },
    [navigation, project.id],
  );

  const components = useMarkdownAssetComponents({
    projectTypeId,
    docPath: articlePath,
    onNavigate,
  });

  useEffect(() => {
    if (!projectTypeId) return;
    let cancelled = false;
    setBody(null);
    setError(null);

    void (async () => {
      try {
        const action = new ActionInfo('fs', projectTypeId.type, projectTypeId.id, 'GET');
        action.subpath = ['download', articlePath];
        action.isRawResponse = true;
        action.responseType = 'blob';
        const blob = await dataManager.callAction<unknown, Blob>(action);
        const text = await blob.text();
        if (!cancelled) setBody(text);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'This guide could not be loaded.'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectTypeId, articlePath]);

  return (
    <article className="flex flex-col gap-4" data-testid="helpdesk-article">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit gap-1 text-muted-foreground"
        onClick={() => navigation.openDock(DockPointer.forHelpdesk(project.id))}
        data-testid="helpdesk-article-back"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        <Trans>All guides</Trans>
      </Button>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : body === null ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : (
        <div className="text-sm">
          <MarkdownView value={body} components={components} />
        </div>
      )}
    </article>
  );
}
