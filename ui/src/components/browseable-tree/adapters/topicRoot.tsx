import React from 'react';
import { Hash, Sparkles, Trash2 } from 'lucide-react';
import apiClient from '@sdk/client';
import { Topic, RESERVED_TOPIC_ROOTS, config } from '@sdk';
import type { Browseable, ToolbarAction } from '@src/components/browseable-tree/types';
import { CountChip } from '@src/components/browseable-tree/CountChip';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';

/**
 * Topics gardening view — the `topic` type root's children in the Assets tree
 * (already dev-gated: the type is `browseable_by=DEV`).
 *
 * Merges two sources into one taxonomy tree grouped by first segment:
 *  - BLESSED topics: Topic entities (generic `/graph/topic` list) — normal rows.
 *  - OBSERVED topics: names seen on the backend bus with no entity row
 *    (`/debug/observed_topics`) — dimmed rows with a "Bless" affordance that
 *    creates the entity. Observation NEVER auto-mints; blessing is this
 *    explicit click.
 */

interface BlessedTopic {
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

export interface TopicRow {
  name: string;
  blessed: BlessedTopic | null;
  observed: ObservedStat | null;
}

/** Pure merge: one row per name, blessed identity attached when present.
 *  Exported for unit tests. */
export function mergeTopicRows(
  blessed: BlessedTopic[],
  observed: Record<string, ObservedStat>,
): Map<string, TopicRow[]> {
  const rows = new Map<string, TopicRow>();
  for (const b of blessed) {
    if (!b?.name) continue;
    rows.set(b.name, { name: b.name, blessed: b, observed: null });
  }
  for (const [name, stat] of Object.entries(observed ?? {})) {
    const existing = rows.get(name);
    if (existing) existing.observed = stat;
    else rows.set(name, { name, blessed: null, observed: stat });
  }
  const byRoot = new Map<string, TopicRow[]>();
  for (const row of rows.values()) {
    const root = row.name.split('.', 1)[0];
    const arr = byRoot.get(root) ?? [];
    arr.push(row);
    byRoot.set(root, arr);
  }
  for (const arr of byRoot.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  return new Map([...byRoot.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchBlessed(): Promise<BlessedTopic[]> {
  try {
    const data = (await apiClient.get('/graph/topic')) as BlessedTopic[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchObserved(): Promise<Record<string, ObservedStat>> {
  try {
    const data = (await apiClient.get('/debug/observed_topics')) as {
      observed?: Record<string, ObservedStat>;
    } | null;
    return data?.observed ?? {};
  } catch {
    return {};
  }
}

function blessAction(name: string, rootId: string): ToolbarAction {
  return {
    id: `bless:${name}`,
    icon: <Sparkles />,
    label: `Bless "${name}" — create its Topic entity`,
    run: async () => {
      await new Topic({ name, title: name }).save();
      refreshNode(rootId);
    },
  };
}

function topicRow(row: TopicRow, rootId: string): Browseable {
  const { name, blessed, observed } = row;
  const badge = observed ? (
    <CountChip
      count={observed.count}
      title={`seen ${observed.count}× since boot · last target ${observed.last_target}`}
    />
  ) : undefined;

  // System-family names are authored in SYSTEM_TOPIC_SEED (code-reviewed),
  // never ad-hoc blessed — the backend gate rejects them and `system` is
  // server-derived, so the UI simply doesn't offer the action.
  const reservedRoot = RESERVED_TOPIC_ROOTS.has(name.split('.', 1)[0]);
  const toolbar: ToolbarAction[] = [];
  if (!blessed) {
    if (!reservedRoot) toolbar.push(blessAction(name, rootId));
  } else if (!blessed.system) {
    toolbar.push({
      id: `delete:topic:${blessed.id}`,
      icon: <Trash2 />,
      label: `Delete topic ${name}`,
      run: () =>
        showDeleteAssetModal({
          name,
          onConfirm: async () => {
            await apiClient.delete(`${config.API_PREFIXES.graph}/topic/${blessed.id}`);
          },
          onAfterDelete: () => refreshNode(rootId),
        }),
      showBusyIndicator: false,
    });
  }

  return {
    id: `topic:${name}`,
    kind: 'asset',
    label: name,
    icon: <Hash className="h-3.5 w-3.5 flex-shrink-0" />,
    badge,
    // Anonymous (observed-only) rows are the dimmed half of the gardening
    // diff; blessing brightens them by giving them an entity row.
    rowClassName: blessed ? undefined : 'opacity-50 hover:opacity-100',
    tooltip: blessed
      ? blessed.description || blessed.title || undefined
      : reservedRoot
        ? 'Observed system-family topic — document it in SYSTEM_TOPIC_SEED (flow_sdk/builtin/topic.py)'
        : undefined,
    // Dogfooding: every row is itself topic-tagged, so clicks land on the bus.
    topic: name,
    hasChildren: false,
    // Row-only entity with no editor surface yet — header-only row.
    pointer: null,
    toolbar: toolbar.length > 0 ? toolbar : undefined,
  };
}

/** Children of the `topic` type root: one group node per first segment. */
export async function topicListChildren(rootId: string): Promise<Browseable[]> {
  const [blessed, observed] = await Promise.all([fetchBlessed(), fetchObserved()]);
  const byRoot = mergeTopicRows(blessed, observed);
  return [...byRoot.entries()].map(([root, rows]) => ({
    id: `topic-family:${root}`,
    kind: 'folder',
    label: root,
    icon: <Hash className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
    badge: <CountChip count={rows.length} />,
    hasChildren: true,
    pointer: null,
    listChildren: () => Promise.resolve(rows.map((row) => topicRow(row, rootId))),
  }));
}
