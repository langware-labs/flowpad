import { APIEntity, FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { FileQuestion, Hammer, RefreshCw } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

interface MissingAssetCardProps<T extends APIEntity<T>> {
  typeLabel: string;
  fsRef: FSRef;
  onRetry: () => void;
  /**
   * Stale orphan entity, when one exists. Distinguishes the
   * "row exists, file gone" case (entity provided — show id / orphan_since)
   * from the "never existed" case (entity null/undefined). Purely
   * informational; no delete affordance here (out of scope).
   */
  entity?: T | null;
  /**
   * Provided only when the entity OWNS its backing file (owns_main_ref types
   * like task/spec): a single save re-renders the file from its default body,
   * so an orphaned row (missing file / no asset_ref) can self-heal. Rebuilds
   * then retries. Absent for hand-edited files (markdown/skill), where
   * rebuilding from a template would clobber user content.
   */
  onRebuild?: () => void;
}

/**
 * Terminal "missing asset" surface for the editor pane.
 *
 * Rendered by `EntityResolutionGate` when `useEntityByPath` settles to
 * `state === 'missing_asset'` — either the backend's discoverByPath returned
 * 404, or a row was matched but its FSIndexer-driven ``orphan`` flag is true
 * (file gone). Distinct from a transient error: retry only helps if the file
 * has since been created or moved, so the affordance is explicit rather than
 * auto-retrying.
 *
 * When ``entity`` is provided (orphan case), shows the entity id + the
 * ``orphan_since`` timestamp so the user can correlate the dangling row with
 * what they expected to see.
 */
export function MissingAssetCard<T extends APIEntity<T>>({
  typeLabel,
  fsRef,
  onRetry,
  entity,
  onRebuild,
}: MissingAssetCardProps<T>) {
  const orphanSinceRaw = (entity as { orphan_since?: string | null } | null | undefined)
    ?.orphan_since;
  const lastSeen = orphanSinceRaw ? formatOrphanSince(orphanSinceRaw) : null;

  return (
    <div className="flex h-full items-center justify-center" data-testid="entity-resolution-missing-asset">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-sm">
        <FileQuestion className="h-6 w-6 text-muted-foreground" />
        <div className="text-center">
          <div className="font-medium"><Trans>Missing asset</Trans></div>
          <div className="mt-1 break-all text-xs text-muted-foreground">{fsRef.path}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            <Trans>The file may have been deleted, moved, or doesn't match the {typeLabel} format.</Trans>
          </div>
          {entity && (
            <div className="mt-2 break-all text-xs text-muted-foreground">
              Stale entity: id <code className="font-mono">{entity.id}</code>
              {lastSeen ? <>, last seen on {lastSeen}</> : null}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {onRebuild && (
            <Button size="sm" onClick={onRebuild} data-testid="missing-asset-rebuild">
              <Hammer className="mr-1 h-3 w-3" /> <Trans>Rebuild file</Trans>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="missing-asset-retry">
            <RefreshCw className="mr-1 h-3 w-3" /> <Trans>Retry</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatOrphanSince(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString();
}
