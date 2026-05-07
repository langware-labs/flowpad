import { FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { FileQuestion, RefreshCw } from 'lucide-react';

interface NotFoundCardProps {
  typeLabel: string;
  fsRef: FSRef;
  onRetry: () => void;
}

/**
 * Terminal "no entity found" surface for the editor pane.
 *
 * Rendered by `EntityResolutionGate` when `useEntityByPath` settles to
 * `state === 'not_found'` — i.e. the backend's discoverByPath returned 404
 * for this path/type. Distinct from a transient error: retry only helps if
 * the file has since been created or moved, so the affordance is explicit
 * rather than auto-retrying.
 */
export function NotFoundCard({ typeLabel, fsRef, onRetry }: NotFoundCardProps) {
  return (
    <div className="flex h-full items-center justify-center" data-testid="entity-resolution-not-found">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-sm">
        <FileQuestion className="h-6 w-6 text-muted-foreground" />
        <div className="text-center">
          <div className="font-medium">No {typeLabel} found</div>
          <div className="mt-1 break-all text-xs text-muted-foreground">{fsRef.path}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            The file may have been deleted, moved, or doesn't match the {typeLabel} format.
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="not-found-retry">
            <RefreshCw className="mr-1 h-3 w-3" /> Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
