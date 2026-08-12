import type { APIEntity, AssetOccurrence } from '@sdk';
import { AlertTriangle } from 'lucide-react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { WikiLabel } from '@src/components/wiki-tip/WikiLabel';
import { useAssistantWikiSpace } from '@src/components/wiki-tip/assistant-wiki';
import { formatTimeAgo } from '@src/utils/format-time-ago';

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

export function AssetCollisionProvider({ entity, children }: { entity: CollisionEntity | null; children: ReactNode }) {
  // APIEntity is updated in place by the data layer. Include the backend
  // projection in the context value so cached/ported drawer consumers are
  // invalidated even when the entity object identity itself is unchanged.
  // Opaque invalidation token — nothing parses it, so serializing the whole
  // backend-ordered projection beats hand-listing fields that then have to be
  // remembered every time the projection grows.
  const projectionKey = `${entity?.duplicate_count ?? 0}:${JSON.stringify(entity?.asset_occurrences ?? [])}`;
  const value = useMemo(() => ({ entity, projectionKey }), [entity, projectionKey]);
  return <AssetCollisionContext.Provider value={value}>{children}</AssetCollisionContext.Provider>;
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

  const label = `This file exists in ${count + 1} places — ${count} ignored ${count === 1 ? 'copy' : 'copies'}`;
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

const ORIGIN_LABEL: Record<string, string> = {
  installed_package: 'Inside an installed package',
  dependency: 'Inside a dependency folder',
  local: 'A file in your workspace',
};

const BASIS_LABEL: Record<string, string> = {
  git: 'oldest in Git history',
  created: 'oldest file on disk',
  first_seen: 'indexed first',
  path: 'first by path — nothing else separated them',
};

/**
 * Split each path into the directory prefix every occurrence shares and the
 * part that actually differs. The shared head is pure noise in a collision
 * list — it is identical by definition — and eliding it is what makes two deep
 * absolute paths comparable at a glance.
 */
function commonPathPrefix(paths: string[]): string {
  if (paths.length < 2) return '';
  const segments = paths.map((p) => p.split('/'));
  let shared = 0;
  while (
    shared < segments[0].length - 1 &&
    segments.every((s) => s.length > shared + 1 && s[shared] === segments[0][shared])
  ) {
    shared += 1;
  }
  return shared === 0 ? '' : segments[0].slice(0, shared).join('/') + '/';
}

/** `2026-08-04 19:27 UTC` — absolute, unambiguous, and stable across locales. */
function absolute(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const stamp = t.toISOString();
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
}

function TimeFact({ label, iso }: { label: string; iso: string | undefined }) {
  const abs = absolute(iso);
  if (!abs) return null;
  const ago = formatTimeAgo(iso);
  // The drawer is only ~320px wide: let the label absorb any overflow so the
  // timestamp and its relative gloss always stay together on one line.
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="whitespace-nowrap text-end tabular-nums" title={abs}>
        {abs}
        {ago ? <span className="ms-1 text-muted-foreground">({ago})</span> : null}
      </span>
    </div>
  );
}

/** Read-only projection of the backend-selected primary and duplicate paths. */
export function AssetCollisionPanel({ entity: explicitEntity }: { entity?: CollisionEntity }) {
  const contextualEntity = useAssetCollisionEntity();
  const entity = explicitEntity ?? contextualEntity;
  const occurrences = entity ? projectedOccurrences(entity) : [];
  const shared = commonPathPrefix(occurrences.map((o) => o.path));
  const primaryBasis = occurrences[0]?.rank_basis;
  const assistantWikiSpace = useAssistantWikiSpace();

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-collision-panel">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">This file exists in {occurrences.length} places</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Same asset id in all of them — FlowPad reads only the live copy, so edits to the{' '}
          {occurrences.length === 2 ? 'other one' : `other ${occurrences.length - 1}`} will not appear.
          {primaryBasis && BASIS_LABEL[primaryBasis] ? (
            <span data-testid="asset-collision-basis"> Live copy: {BASIS_LABEL[primaryBasis]}.</span>
          ) : null}
        </p>
        <div className="mt-2 text-xs">
          {/* Explicit space: this panel appears on duplicated assets in the
              user's OWN projects, where the `@local` alias would resolve their
              wiki and miss the shipped page entirely. */}
          <WikiLabel wikiword="Duplicate assets" label="Learn about duplicates" space={assistantWikiSpace} />
        </div>
      </div>
      {shared ? (
        <div className="border-b px-4 py-2 text-[11px] text-muted-foreground">
          <span className="me-1">Common path</span>
          <span className="break-all font-mono" title={shared}>
            {shared}
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {occurrences.map((occurrence) => (
          <div
            key={occurrence.path}
            data-testid={occurrence.primary ? 'asset-collision-row-primary' : 'asset-collision-row-duplicate'}
            className={`mb-2 rounded-md border p-3 last:mb-0 ${
              occurrence.primary ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
            }`}
          >
            <div className="mb-1.5 flex items-baseline gap-2">
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  occurrence.primary
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                }`}
              >
                {occurrence.primary ? 'Live' : 'Ignored'}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {ORIGIN_LABEL[occurrence.origin ?? 'local']}
              </span>
            </div>
            <div className="break-all font-mono text-xs" title={occurrence.path}>
              {shared ? <span className="text-muted-foreground">…/</span> : null}
              {occurrence.path.slice(shared.length)}
            </div>
            <div className="mt-2 space-y-0.5 border-t pt-2 text-[11px]">
              <TimeFact label="In Git since" iso={occurrence.introduced_at} />
              <TimeFact label="Created" iso={occurrence.birth_time} />
              <TimeFact label="First indexed" iso={occurrence.first_seen_at} />
            </div>
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
export function AssetCollisionShell({ entity, children }: { entity: CollisionEntity; children: ReactNode }) {
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
