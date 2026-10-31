import type { SearchResult } from '@sdk/services/search-service';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Trans } from '@lingui/react/macro';

/** Shown when a link's target is not where it points: the files that may be meant. */
export function LinkSuggestDialog({
  name,
  results,
  onPick,
  onClose,
}: {
  name: string;
  results: SearchResult[];
  onPick: (r: SearchResult) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="link-suggest-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Link target not found</Trans>
          </DialogTitle>
          <DialogDescription>
            {results.length ? (
              <Trans>No file at the link's path. Did you mean one of these for {name}?</Trans>
            ) : (
              <Trans>No file named {name} was found.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1">
          {results.map((r) => (
            <li key={`${r.record_type}-${r.record_id}`}>
              <button
                className="w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => onPick(r)}
              >
                <div className="text-sm font-medium">{r.name}</div>
                {r.asset_ref && <div className="break-all font-mono text-xs text-muted-foreground">{r.asset_ref}</div>}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
