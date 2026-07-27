import React from 'react';
import { GitFork, Sparkles, Trash2 } from 'lucide-react';
import apiClient from '@sdk/client';
import { Tag, RESERVED_TAG_ROOTS, config } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import type { Browseable, ToolbarAction } from '@src/components/browseable-tree/types';
import { CountChip } from '@src/components/browseable-tree/CountChip';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';

/** Tag's glyph, resolved from the backend type registry (never hardcoded —
 *  see the type-icon law in CLAUDE.md). */
const TagIcon = () => {
  const Icon = iconForType('tag');
  return <Icon className="h-3.5 w-3.5 flex-shrink-0" />;
};

/**
 * Tags gardening view — the `tag` type root's children in the Assets tree
 * (already dev-gated: the type is `browseable_by=DEV`).
 *
 * Merges two sources into one taxonomy tree grouped by first segment:
 *  - BLESSED tags: Tag entities (generic `/graph/tag` list) — normal rows.
 *  - OBSERVED tags: names seen on the backend bus with no entity row
 *    (`/debug/observed_tags`) — dimmed rows with a "Bless" affordance that
 *    creates the entity. Observation NEVER auto-mints; blessing is this
 *    explicit click.
 */

interface BlessedTag {
  id: string;
  name: string;
  title?: string | null;
  description?: string | null;
  system?: boolean;
  deprecated?: boolean;
}

interface ObservedStat {
  count: number;
  first_ts: string;
  last_ts: string;
  last_target: string;
}

export interface TagRow {
  name: string;
  blessed: BlessedTag | null;
  observed: ObservedStat | null;
}

/** Pure merge: one row per name, blessed identity attached when present.
 *  Exported for unit tests. */
export function mergeTagRows(blessed: BlessedTag[], observed: Record<string, ObservedStat>): Map<string, TagRow[]> {
  const rows = new Map<string, TagRow>();
  for (const b of blessed) {
    if (!b?.name) continue;
    rows.set(b.name, { name: b.name, blessed: b, observed: null });
  }
  for (const [name, stat] of Object.entries(observed)) {
    const existing = rows.get(name);
    if (existing) existing.observed = stat;
    else rows.set(name, { name, blessed: null, observed: stat });
  }
  const byRoot = new Map<string, TagRow[]>();
  for (const row of rows.values()) {
    const root = row.name.split('.', 1)[0];
    const arr = byRoot.get(root) ?? [];
    arr.push(row);
    byRoot.set(root, arr);
  }
  for (const arr of byRoot.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  return new Map([...byRoot.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchBlessed(): Promise<BlessedTag[]> {
  try {
    const data = (await apiClient.get('/graph/tag')) as BlessedTag[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchObserved(): Promise<Record<string, ObservedStat>> {
  try {
    const data = (await apiClient.get('/debug/observed_tags')) as {
      observed?: Record<string, ObservedStat>;
    } | null;
    return data?.observed ?? {};
  } catch {
    return {};
  }
}

function blessAction(name: string, refreshId: string): ToolbarAction {
  return {
    id: `bless:${name}`,
    icon: <Sparkles />,
    label: `Bless "${name}" — create its Tag entity`,
    run: async () => {
      await new Tag({ name, title: name }).save();
      refreshNode(refreshId);
    },
  };
}

function tagRow(row: TagRow, refreshId: string): Browseable {
  const { name, blessed, observed } = row;
  const badge = observed ? (
    <CountChip
      count={observed.count}
      title={`seen ${observed.count}× since boot · last target ${observed.last_target}`}
    />
  ) : undefined;

  // System-family names are authored in SYSTEM_TAG_SEED (code-reviewed),
  // never ad-hoc blessed — the backend gate rejects them and `system` is
  // server-derived, so the UI simply doesn't offer the action.
  const reservedRoot = RESERVED_TAG_ROOTS.has(name.split('.', 1)[0]);
  const toolbar: ToolbarAction[] = [];
  if (!blessed) {
    if (!reservedRoot) toolbar.push(blessAction(name, refreshId));
  } else if (!blessed.system) {
    toolbar.push({
      id: `delete:tag:${blessed.id}`,
      icon: <Trash2 />,
      label: `Delete tag ${name}`,
      run: () =>
        showDeleteAssetModal({
          name,
          onConfirm: async () => {
            await apiClient.delete(`${config.API_PREFIXES.graph}/tag/${blessed.id}`);
          },
          onAfterDelete: () => refreshNode(refreshId),
        }),
      showBusyIndicator: false,
    });
  }

  return {
    id: `tag:${name}`,
    kind: 'asset',
    label: name,
    icon: <TagIcon />,
    badge,
    // Anonymous (observed-only) rows are the dimmed half of the gardening
    // diff; blessing brightens them by giving them an entity row.
    rowClassName: blessed ? undefined : 'opacity-50 hover:opacity-100',
    tooltip: blessed
      ? blessed.description || blessed.title || undefined
      : reservedRoot
        ? 'Observed system-family tag — document it in SYSTEM_TAG_SEED (flow_sdk/builtin/tag.py)'
        : undefined,
    // Dogfooding: every row is itself tagged, so clicks land on the bus.
    tag: name,
    hasChildren: false,
    // URL-first: clicking a tag opens the tag graph focused on it.
    pointer: DockPointer.forTagGraph(name),
    toolbar: toolbar.length > 0 ? toolbar : undefined,
  };
}

/** Children of the `tag` type root: one group node per first segment. */
export async function tagListChildren(rootId: string): Promise<Browseable[]> {
  const [blessed, observed] = await Promise.all([fetchBlessed(), fetchObserved()]);
  const byRoot = mergeTagRows(blessed, observed);
  const graphRow: Browseable = {
    id: 'tag-graph-entry',
    kind: 'asset',
    label: 'Tag graph',
    icon: <GitFork className="h-3.5 w-3.5 flex-shrink-0" />,
    hasChildren: false,
    pointer: DockPointer.forTagGraph(),
  };
  return [
    graphRow,
    ...[...byRoot.entries()].map(([root, rows]) => {
      const familyId = `tag-family:${root}`;
      return {
        id: familyId,
        kind: 'folder' as const,
        label: root,
        icon: <TagIcon />,
        badge: <CountChip count={rows.length} />,
        hasChildren: true,
        pointer: null,
        // Family refreshes must read current state. Capturing ``rows`` here
        // leaves an expanded family stale after blessing/deleting a Tag even
        // when the refresh bus correctly invalidates this node.
        listChildren: async () => {
          const [freshBlessed, freshObserved] = await Promise.all([fetchBlessed(), fetchObserved()]);
          const freshRows = mergeTagRows(freshBlessed, freshObserved).get(root) ?? [];
          return freshRows.map((row) => tagRow(row, familyId));
        },
      };
    }),
  ];
}
