import { ReactNode } from 'react';
import { APIEntity, FSRef } from '@sdk';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { MissingAssetCard } from './MissingAssetCard';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@src/components/ui/button';

interface EntityResolutionGateProps<T extends APIEntity<T>> {
  /** Entity type, e.g. `Workflow.type`. */
  type: string;
  /** Path to resolve. */
  fsRef: FSRef;
  /** Display label for status messages, e.g. "workflow", "agent". */
  typeLabel: string;
  /** Render the editor when the entity resolves. */
  render: (entity: T) => ReactNode;
}

/**
 * Unified resolution surface for editors that key off an FSRef.
 *
 * Drives `useEntityByPath` and renders the right state:
 *   - `querying` / `discovering` → spinner with phase-specific label
 *   - `resolved` → delegates to `render(entity)`
 *   - `missing_asset` → `<MissingAssetCard>` (terminal; explicit retry).
 *     When the hook surfaces a stale orphan via ``entity``, it's forwarded
 *     to the card so the user sees id / orphan_since.
 *   - `error` → inline error card with Retry button
 *
 * Use from editor wrappers to remove ad-hoc "isLoading ? spinner : null"
 * scaffolding and ensure every editor handles bulk-miss recovery uniformly.
 */
export function EntityResolutionGate<T extends APIEntity<T>>({
  type,
  fsRef,
  typeLabel,
  render,
}: EntityResolutionGateProps<T>) {
  const { entity, state, error, retry } = useEntityByPath<T>(type, fsRef);

  if (state === 'resolved' && entity) return <>{render(entity)}</>;

  if (state === 'querying' || state === 'discovering') {
    const label = state === 'discovering' ? `Discovering ${typeLabel}…` : `Loading ${typeLabel}…`;
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
        data-testid="entity-resolution-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {label}
      </div>
    );
  }

  if (state === 'missing_asset') {
    // ``entity`` is populated when there's a stale orphan row; null when
    // the path resolves to nothing at all. Forward either way — the card
    // renders the orphan-detail line only when ``entity`` is truthy.
    return <MissingAssetCard typeLabel={typeLabel} fsRef={fsRef} onRetry={retry} entity={entity} />;
  }

  // error
  return (
    <div className="flex h-full items-center justify-center" data-testid="entity-resolution-error">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <div className="text-center">
          <div className="font-medium">Failed to load {typeLabel}</div>
          <div className="mt-1 text-xs text-muted-foreground">{error?.message ?? 'Unknown error'}</div>
        </div>
        <Button size="sm" variant="outline" onClick={retry} data-testid="entity-resolution-retry">
          Retry
        </Button>
      </div>
    </div>
  );
}
