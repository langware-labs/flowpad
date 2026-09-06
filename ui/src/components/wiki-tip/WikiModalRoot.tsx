import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { WikiResolveView } from '@src/components/assets/editor/WikiResolveView';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { assistantWikiRef } from './assistant-wiki';
import { HubWikiMarkdown } from './HubWikiMarkdown';
import { useWikiModalStore } from './wiki-modal';

/**
 * Global host for `openWikiModal(wikiword)`. Mounted once near the app root
 * (App.tsx, next to ActivityProgressModalRoot). Renders the wiki page inline
 * via the existing `WikiResolveView` so the modal reuses the same resolver +
 * markdown editor the full-page wiki view uses. See docs/wikitip.md.
 *
 * Two things every caller would otherwise have to get right live here, once:
 *
 * - A target with no `space` is a SHIPPED page, so it is looked up in the
 *   assistant project's wiki. The `@local` alias resolves against the active
 *   project, where a help page never lives (see `assistant-wiki.ts`).
 * - On the HUB runtime there is no wiki graph entity to resolve, so the body
 *   is the legacy route's markdown instead ({@link HubWikiMarkdown}).
 */
export function WikiModalRoot() {
  const open = useWikiModalStore((s) => s.open);
  const setOpen = useWikiModalStore((s) => s.setOpen);
  const target = useWikiModalStore((s) => s.payload);
  const wikiword = target?.wikiword ?? '';

  // The shipped-docs space: `undefined` until looked up, `null` when there is
  // no assistant project to look it up in (then `@local` is all we have).
  const [docsSpace, setDocsSpace] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (isHubOnly()) return;
    let cancelled = false;
    void assistantWikiRef().then((ref) => {
      if (!cancelled) setDocsSpace(ref);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Wait for the lookup rather than opening on `@local` and re-resolving: the
  // page would flash "no page exists with this name" before the right one.
  const space = target?.space ?? (docsSpace === undefined ? undefined : (docsSpace ?? '@local'));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{wikiword}</DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Preview of the wiki page, shown without leaving the current view.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="h-[70vh] overflow-auto">
          {!open || !wikiword ? null : isHubOnly() ? (
            <HubWikiMarkdown name={wikiword} />
          ) : space ? (
            <WikiResolveView name={wikiword} space={space} fragment={target?.fragment} variant="plain" />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
