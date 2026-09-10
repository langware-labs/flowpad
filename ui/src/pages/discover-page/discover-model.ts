/**
 * The Discover page's read model, as pure functions: one item shape over the
 * hub directory row, the desk's published row and the desk's not-yet-published
 * candidate, plus the filters, sorts, facets and labels the page and the
 * detail route both need. No React, no I/O — the hooks feed it.
 */
import { gitOriginWebUrl, type DirectoryRow, type GitOrigin, type PublishedRow, type PublishedState, type UnpublishedRow } from '@sdk';
import { installSnippet } from '@src/components/install/InstallSnippetDialog';

export type BodyState = Pick<DirectoryRow, 'body_supported' | 'body_available' | 'body_reason' | 'body_ref'>;

export interface DiscoverItem {
  typeid: string;
  type: string;
  id: string;
  name: string;
  description: string;
  /** `null` for a candidate that is not published yet (desk only). */
  state: PublishedState | null;
  publishedAt: string | null;
  relPath: string | null;
  /** Absolute path on this machine; desk only. */
  posixPath: string | null;
  origin: Record<string, unknown> | null;
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  /** Whether the document can be read on the hub; hub rows only. */
  body: BodyState | null;
  /** What the publishing desk did about the hub body; desk rows only. */
  hubBody: PublishedRow['hub_body'] | null;
}

export type SortKey = 'published_at' | 'name' | 'type';

export function fromDirectoryRow(r: DirectoryRow): DiscoverItem {
  return {
    typeid: r.typeid,
    type: r.type,
    id: r.id,
    name: r.name || '(untitled)',
    description: r.description || '',
    state: r.state,
    publishedAt: r.published_at || null,
    relPath: r.rel_path || null,
    posixPath: null,
    origin: r.origin ?? null,
    sourceProjectId: r.source_project_id,
    sourceProjectName: r.source_project_name,
    body: { body_supported: r.body_supported, body_available: r.body_available, body_reason: r.body_reason, body_ref: r.body_ref },
    hubBody: null,
  };
}

export function fromPublished(r: PublishedRow, project: { id: string; name: string } | null): DiscoverItem {
  return {
    typeid: r.typeid,
    type: r.type,
    id: r.id,
    name: r.name || '(untitled)',
    description: r.description || '',
    state: r.state,
    publishedAt: r.published_at || null,
    relPath: r.rel_path || null,
    posixPath: r.posix_path ?? null,
    origin: r.origin ?? null,
    sourceProjectId: project?.id ?? null,
    sourceProjectName: project?.name ?? null,
    body: null,
    hubBody: r.hub_body ?? null,
  };
}

export function fromUnpublished(r: UnpublishedRow, project: { id: string; name: string } | null): DiscoverItem {
  const dash = r.typeid.lastIndexOf('-', r.typeid.length - 37);
  return {
    typeid: r.typeid,
    type: r.type,
    id: r.typeid.slice(dash + 1),
    name: r.name || '(untitled)',
    description: '',
    state: null,
    publishedAt: null,
    relPath: null,
    posixPath: r.posix_path,
    origin: null,
    sourceProjectId: project?.id ?? null,
    sourceProjectName: project?.name ?? null,
    body: null,
    hubBody: null,
  };
}

export function filterItems(
  items: DiscoverItem[],
  f: { query?: string; type?: string | null; projectId?: string | null },
): DiscoverItem[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return items.filter(
    (i) =>
      (!f.type || i.type === f.type) &&
      (!f.projectId || i.sourceProjectId === f.projectId) &&
      (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)),
  );
}

export function sortItems(items: DiscoverItem[], key: SortKey): DiscoverItem[] {
  const byName = (a: DiscoverItem, b: DiscoverItem) => a.name.localeCompare(b.name);
  const sorted = [...items];
  if (key === 'name') return sorted.sort(byName);
  if (key === 'type') return sorted.sort((a, b) => a.type.localeCompare(b.type) || byName(a, b));
  // Newest first; a candidate without a date sorts after every published row.
  return sorted.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || byName(a, b));
}

export function typeFacets(items: DiscoverItem[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  items.forEach((i) => counts.set(i.type, (counts.get(i.type) ?? 0) + 1));
  return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
}

export function projectFacets(items: DiscoverItem[]): { id: string; name: string; count: number }[] {
  const counts = new Map<string, { id: string; name: string; count: number }>();
  items.forEach((i) => {
    if (!i.sourceProjectId) return;
    const cur = counts.get(i.sourceProjectId) ?? { id: i.sourceProjectId, name: i.sourceProjectName ?? i.sourceProjectId, count: 0 };
    cur.count += 1;
    counts.set(i.sourceProjectId, cur);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** The shell form of Install — the same desk path the Add-asset dialog runs. */
export function installCommand(typeid: string): string {
  return `flow asset install ${typeid}`;
}

/** What turns a bare machine into a signed-in desktop; the install line comes after. */
export function bootstrapCommand(): string {
  return installSnippet('').slice(0, 3).join(' && ');
}

export type Provenance = { kind: 'git'; label: string; href: string | null; provider: string } | { kind: 'local' } | null;

/** Where the row's bytes come from, as a label and (for git) a page to open. */
export function provenanceOf(origin: Record<string, unknown> | null | undefined): Provenance {
  if (!origin || typeof origin !== 'object') return null;
  if (origin.kind === 'git') {
    const o = origin as unknown as GitOrigin;
    if (!o.owner || !o.name) return null;
    return {
      kind: 'git',
      label: o.branch ? `${o.owner}/${o.name}@${o.branch}` : `${o.owner}/${o.name}`,
      href: gitOriginWebUrl(o, { isDir: true }),
      provider: String(o.provider ?? ''),
    };
  }
  if (origin.kind === 'local') return { kind: 'local' };
  return null;
}

/**
 * How a published state looks — the `health-style` pattern: a chip fill plus a
 * row rail, keyed by the union so a new state is a type error here, not an
 * unstyled chip. Labels live with the components (they are translated).
 */
export const STATE_STYLE: Record<PublishedState, { chip: string; border: string }> = {
  in_use: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', border: 'border-s-emerald-500/60' },
  install: { chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', border: 'border-s-sky-500/60' },
  stale: { chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-300', border: 'border-s-amber-500/70' },
  missing: { chip: 'bg-red-500/10 text-red-700 dark:text-red-300', border: 'border-s-red-500/70' },
};

/** A candidate row (not published yet) — no rail, muted chip. */
export const UNPUBLISHED_STYLE = { chip: 'bg-muted text-muted-foreground', border: 'border-s-border' };

export function styleOf(state: PublishedState | null): { chip: string; border: string } {
  return state ? STATE_STYLE[state] : UNPUBLISHED_STYLE;
}

/**
 * Why the document is not on the hub — one key per cause the hub or the desk
 * can report; the component turns it into a sentence. `null` when it is there.
 */
export type BodyCopyKey =
  | 'type_not_git'
  | 'not_on_hub_local'
  | 'not_on_hub_git'
  | 'not_materialized'
  | 'project_not_linked'
  | 'github_not_connected'
  | 'publish_failed';

export function bodyCopyKey(item: DiscoverItem): BodyCopyKey | null {
  const desk = item.hubBody;
  if (desk && desk.status !== 'published') {
    if (desk.code === 'type_not_git') return 'type_not_git';
    if (desk.code === 'project_not_linked') return 'project_not_linked';
    if (desk.code === 'github_not_connected') return 'github_not_connected';
    return 'publish_failed';
  }
  const body = item.body;
  if (!body || body.body_available) return null;
  if (body.body_reason === 'type_not_git') return 'type_not_git';
  if (body.body_reason === 'not_materialized') return 'not_materialized';
  return item.origin?.kind === 'local' ? 'not_on_hub_local' : 'not_on_hub_git';
}
