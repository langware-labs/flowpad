/**
 * Pure decision logic for the unified content-panel tab strip
 * (docs/tab-management.md Part 3 §5/§6) — kept React-free so the preview
 * semantics, the global-section partition and the localStorage default are
 * unit-testable without mounting the strip.
 */
import { ViewType } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { VIEWER_REGISTRY } from '@src/types/ViewType';
import type { EntityTabRow } from './useTabs';

// ─── Global section (Part 3 §6) ─────────────────────────────────────────────
// Always visible — the localStorage show/hide checkbox was removed as
// confusing (2026-06-11).

/**
 * Split entity rows into the current-project section and the global section.
 * Project rows keep the strict project filter (same rule as the terminals);
 * rows with `projectId == null` belong to the global section ONLY — when no
 * project is active they are not duplicated into the project section.
 */
export function partitionEntityRows(
  rows: EntityTabRow[],
  projectId: string | null,
): { projectRows: EntityTabRow[]; globalRows: EntityTabRow[] } {
  const projectRows = projectId == null ? [] : rows.filter((r) => r.projectId === projectId);
  const globalRows = rows.filter((r) => r.projectId == null);
  return { projectRows, globalRows };
}

// ─── Transient preview tab (Part 3 §5) ──────────────────────────────────────

/** Minimal dock shape the model needs (DockPointer satisfies it). */
export interface DockLike {
  viewType?: ViewType;
  pointer?: string;
}

/**
 * The TypeId string when the dock is a canonical asset-editor pointer in its
 * `typeid` form (`editor/<editor>/typeid/<type>-<uuid>`, possibly rebased
 * onto `/dock/project/<id>/…`) — null for every other dock.
 */
export function dockTargetTypeIdKey(dock: DockLike | null): string | null {
  if (!dock?.viewType) return null;
  let assetSub: string | undefined;
  if (dock.viewType === ViewType.ASSETS) {
    assetSub = dock.pointer;
  } else if (dock.viewType === ViewType.PROJECT) {
    assetSub = DockPointer.splitProjectPointer(dock.pointer).assetSubPointer || undefined;
  }
  if (!assetSub || !assetSub.startsWith('editor/')) return null;
  try {
    const parsed = AssetDocPointer.parse(assetSub);
    return parsed.method === AssetRoutingMethod.TYPEID ? parsed.value : null;
  } catch {
    return null;
  }
}

/** Short human hint from a pointer tail — only when it reads like a file. */
function pointerHint(pointer: string | undefined): string | null {
  if (!pointer) return null;
  const last = decodeURIComponent(pointer.split('/').filter(Boolean).pop() ?? '');
  // Only hint with file-ish tails; ids/uuids would be noise on the chip.
  if (!last || !last.includes('.') || last.length > 40) return null;
  return last;
}

export interface TransientTabDescriptor {
  /** Pointer-keyed (Part 3 §2): never collides with a TypeId member key. */
  key: string;
  viewType: ViewType;
  title: string;
  /** VIEWER_REGISTRY icon name; null → generic document glyph fallback. */
  iconName: string | null;
  /** Set when the dock resolves to an entity that `tabs/open` can promote. */
  promotableTypeIdKey: string | null;
}

/**
 * The single transient preview slot (Part 3 §5): present iff the current dock
 * matches neither the terminal surface (ViewType.SHELL — the terminal section
 * owns it) nor an entity member key. Browsing N docs yields N successive
 * descriptors for ONE slot and zero membership writes; promotion
 * (`tabs/open`) is the only write and happens only via the explicit
 * "Keep as tab" action.
 */
export function transientForDock(
  dock: DockLike | null,
  opts: {
    isMemberKey: (key: string) => boolean;
    /** Optional cached-entity name resolver for nicer typeid titles. */
    entityNameForTypeId?: (typeIdKey: string) => string | null;
  },
): TransientTabDescriptor | null {
  if (!dock?.viewType) return null;
  if (dock.viewType === ViewType.SHELL) return null;
  const typeIdKey = dockTargetTypeIdKey(dock);
  if (typeIdKey && opts.isMemberKey(typeIdKey)) return null;
  const meta = VIEWER_REGISTRY[dock.viewType];
  const baseTitle = meta?.title ?? String(dock.viewType);
  const hint = typeIdKey
    ? (opts.entityNameForTypeId?.(typeIdKey) ?? null)
    : pointerHint(dock.pointer);
  return {
    key: `transient:${dock.viewType}/${dock.pointer ?? ''}`,
    viewType: dock.viewType,
    title: hint ? `${baseTitle}: ${hint}` : baseTitle,
    iconName: meta?.iconName ?? null,
    promotableTypeIdKey: typeIdKey,
  };
}
