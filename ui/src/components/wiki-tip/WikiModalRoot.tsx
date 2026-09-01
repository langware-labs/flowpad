import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { WikiResolveView } from '@src/components/assets/editor/WikiResolveView';
import { useWikiModalStore } from './wiki-modal';
import { Trans } from '@lingui/react/macro';

/**
 * Global host for `openWikiModal(wikiword)`. Mounted once near the app root
 * (App.tsx, next to ActivityProgressModalRoot). Renders the wiki page inline
 * via the existing `WikiResolveView` so the modal reuses the same resolver +
 * markdown editor the full-page wiki view uses. See docs/wikitip.md.
 */
export function WikiModalRoot() {
  const open = useWikiModalStore((s) => s.open);
  const setOpen = useWikiModalStore((s) => s.setOpen);
  const target = useWikiModalStore((s) => s.payload);
  const wikiword = target?.wikiword ?? '';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>[[{wikiword}]]</DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Preview of the wiki page, shown without leaving the current view.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="h-[70vh] overflow-auto">
          {open && wikiword ? (
            <WikiResolveView name={wikiword} space={target?.space ?? '@local'} fragment={target?.fragment} variant="plain" />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
