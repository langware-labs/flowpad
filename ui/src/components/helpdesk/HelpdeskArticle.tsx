import { useCallback, useEffect, useState } from 'react';
import type { TypeId } from '@sdk';
import { useFS } from '@src/hooks/useFS';
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
export function HelpdeskArticle({
  projectId,
  projectTypeId,
  articlePath,
}: {
  projectId: string;
  /** Passed in rather than re-derived: the page already holds it. */
  projectTypeId: TypeId | null;
  articlePath: string;
}) {
  const { navigation } = useDockNavigation();
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fs = useFS(projectTypeId ?? undefined);

  const onNavigate = useCallback(
    (resolvedPath: string) => {
      // In-repo links stay in the portal, URL-first.
      navigation.openDock(DockPointer.forHelpdesk(projectId, resolvedPath));
    },
    [navigation, projectId],
  );

  const components = useMarkdownAssetComponents({
    projectTypeId,
    docPath: articlePath,
    onNavigate,
  });

  useEffect(() => {
    // `useFS` returns null without a typeid — same condition, but the compiler
    // needs it stated on `fs` itself.
    if (!projectTypeId || !fs) return;
    let cancelled = false;
    setBody(null);
    setError(null);

    void (async () => {
      try {
        // `fs.download` rather than a hand-built fs ActionInfo: it routes
        // through fsStore, so the content is cached and WS-invalidated — a
        // hand-rolled call bypasses both, and an open article would not refresh
        // after the load dialog's pull.
        const text = await fs.download(articlePath);
        if (!cancelled) setBody(typeof text === 'string' ? text : await text.text());
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'This guide could not be loaded.'));
      }
    })();

    return () => {
      cancelled = true;
    };
    // `fs` is a fresh object each render; the identity that matters is the path pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTypeId, articlePath]);

  return (
    <article className="flex flex-col gap-4" data-testid="helpdesk-article">
      <Button
        variant="ghost"
        size="sm"
        className="-ms-2 w-fit gap-1 text-muted-foreground"
        onClick={() => navigation.openDock(DockPointer.forHelpdesk(projectId))}
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
