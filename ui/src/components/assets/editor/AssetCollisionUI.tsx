import type { APIEntity, AssetOccurrence } from '@sdk';
import { AlertTriangle } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
} from 'react';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { useSideWindows } from '@src/navigation/useSideWindows';

type CollisionEntity = APIEntity<never>;

interface AssetCollisionContextValue {
  entity: CollisionEntity | null;
  projectionKey: string;
}

const AssetCollisionContext = createContext<AssetCollisionContextValue>({
  entity: null,
  projectionKey: '',
});

export function assetCollisionWindowId(entity: CollisionEntity): string {
  return `asset-duplicates:${entity.typeId.toString()}`;
}

export function AssetCollisionProvider({
  entity,
  children,
}: {
  entity: CollisionEntity | null;
  children: ReactNode;
}) {
  // APIEntity is updated in place by the data layer. Include the backend
  // projection in the context value so cached/ported drawer consumers are
  // invalidated even when the entity object identity itself is unchanged.
  const projectionKey = `${entity?.duplicate_count ?? 0}:${(entity?.asset_occurrences ?? [])
    .map((occurrence) => `${occurrence.path}:${occurrence.first_seen_at}`)
    .join('|')}`;
  const value = useMemo(
    () => ({ entity, projectionKey }),
    [entity, projectionKey],
  );
  return (
    <AssetCollisionContext.Provider value={value}>
      {children}
    </AssetCollisionContext.Provider>
  );
}

export function useAssetCollisionEntity(): CollisionEntity | null {
  return useContext(AssetCollisionContext).entity;
}

/** Warning affordance only. Collision identity, ranking, and count stay backend-owned. */
export function AssetCollisionBadge() {
  const entity = useAssetCollisionEntity();
  const { open } = useSideWindows();
  const count = entity?.duplicate_count ?? 0;
  if (!entity || count <= 0) return null;

  const label = `${count} duplicate asset ${count === 1 ? 'copy' : 'copies'}`;
  return (
    <button
      type="button"
      onClick={() => open(assetCollisionWindowId(entity))}
      aria-label={label}
      title={label}
      data-testid="asset-collision-warning"
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
    >
      <AlertTriangle className="h-3 w-3" />
      {count}
    </button>
  );
}

function projectedOccurrences(entity: CollisionEntity): Array<AssetOccurrence & { primary: boolean }> {
  // The backend contract already orders the selected primary first. The UI
  // labels that projection; it never re-ranks or infers collision identity.
  return (entity.asset_occurrences ?? []).map((occurrence, index) => ({
    ...occurrence,
    primary: index === 0,
  }));
}

/** Read-only projection of the backend-selected primary and duplicate paths. */
export function AssetCollisionPanel({ entity: explicitEntity }: { entity?: CollisionEntity }) {
  const contextualEntity = useAssetCollisionEntity();
  const entity = explicitEntity ?? contextualEntity;
  const occurrences = entity ? projectedOccurrences(entity) : [];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-collision-panel">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">Duplicate asset identity</div>
        <p className="mt-1 text-xs text-muted-foreground">
          These paths contain the same asset identity. FlowPad indexes the primary path only.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {occurrences.map((occurrence) => (
          <div
            key={occurrence.path}
            data-testid={occurrence.primary ? 'asset-collision-row-primary' : 'asset-collision-row-duplicate'}
            className="mb-2 rounded-md border p-3 last:mb-0"
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {occurrence.primary ? 'Primary' : 'Duplicate'}
            </div>
            <div className="break-all font-mono text-xs">{occurrence.path}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Collision tab declaration consumed by the existing Markdown drawer registry. */
export function useAssetCollisionSideTab(): ExtraSideTab | null {
  const entity = useAssetCollisionEntity();
  const duplicateCount = entity?.duplicate_count ?? 0;
  return useMemo(() => {
    if (!entity || duplicateCount <= 0) return null;
    return {
      id: assetCollisionWindowId(entity),
      label: `Duplicates ${duplicateCount}`,
      icon: AlertTriangle,
      description: 'Other paths with this asset identity',
      // The Markdown tab registry retains panel elements by id. Read the live
      // context instead of capturing this render's mutable APIEntity prop.
      panel: <AssetCollisionPanel />,
      availableInNonAdvanced: true,
    };
  }, [entity, duplicateCount]);
}

/** Single right-drawer host for entity editors that do not own a Markdown drawer. */
export function AssetCollisionShell({
  entity,
  children,
}: {
  entity: CollisionEntity;
  children: ReactNode;
}) {
  const { windows, close } = useSideWindows();
  const windowId = assetCollisionWindowId(entity);
  const open = windows.includes(windowId);
  return (
    <AssetCollisionProvider entity={entity}>
      <div className="flex h-full min-h-0 w-full">
        <div className="min-w-0 flex-1">{children}</div>
        <SideDrawer
          open={open}
          onOpenChange={() => close(windowId)}
          title="Duplicate assets"
          count={entity.duplicate_count ?? 0}
          width="w-80"
          data-testid="asset-collision-side-window"
        >
          <AssetCollisionPanel entity={entity} />
        </SideDrawer>
      </div>
    </AssetCollisionProvider>
  );
}
