import { t } from '@lingui/core/macro';
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { RunsView } from './RunsView';
import { useRunPreviewStore } from './run-preview';

/**
 * Global host for `openRunPreview(...)` — the executions of ONE thing (a flow,
 * a node, an agent), previewed without leaving the canvas you were reading.
 *
 * It renders the same `RunsView` the destination does, just scoped and in a
 * dialog, so there is exactly one run list in the app rather than a fourth
 * divergent one. `Open` is the continuation: close the overlay, then
 * `navigation.openDock` the same scope as a real URL — the WikiResolveView
 * "Open full page" contract.
 *
 * Mounted once near the app root, next to WikiModalRoot.
 */
export function RunPreviewRoot() {
  const open = useRunPreviewStore((s) => s.open);
  const setOpen = useRunPreviewStore((s) => s.setOpen);
  const target = useRunPreviewStore((s) => s.payload);
  const { navigation } = useDockNavigation();
  // Selection is local to the overlay: a preview must not rewrite the URL of
  // the page behind it (that page is usually the flow canvas you came from).
  const [selected, setSelected] = useState<string | null>(null);

  if (!target) return null;

  const openFull = () => {
    setOpen(false);
    navigation.openDock(DockPointer.forProcessRuns({ ...target.scope, run: selected }));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(null);
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {target.title}
            <Button variant="ghost" size="sm" onClick={openFull} title={t`Open in Runs`} className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> <Trans>Open</Trans>
            </Button>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Executions of this item, shown without leaving the current view.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="h-[70vh] overflow-hidden">
          {open && (
            <RunsView
              compact
              scope={target.scope}
              selectedId={selected ?? target.runId ?? null}
              onSelect={setSelected}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
