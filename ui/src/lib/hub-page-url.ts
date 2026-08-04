import type { TypeId } from '@sdk';
import { PageId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';

function trimHubHost(hubHost: string): string {
  return hubHost.replace(/\/+$/, '');
}

/** Canonical cloud Project Home URL. */
export function hubProjectUrl(hubAppUrl: string | null | undefined, projectId: string | null | undefined): string | null {
  if (!hubAppUrl || !projectId) return null;
  const dockPath = DockPointer.forProject(projectId).withPage(PageId.HUB).toUrl();
  return `${trimHubHost(hubAppUrl)}${dockPath}`;
}

/**
 * Entity types the hub console has a page route for. Mirrors the hub router's
 * own param→type table (`flowpad/ui/src/routes/loaders/console-loader.ts`:
 * pageId→page, flowId→flow, taskId→task, fsItemId→fs_item, agentId→agent,
 * kbId→knowledge_base, workspaceId→workspace) — the route segment IS the entity
 * type, so the pointer is just `<type>/<id>`.
 *
 * Anything absent has no hub page. The hub's catch-all route renders the Landing
 * page rather than a 404, so guessing a URL would look like it worked — we link
 * only what we know resolves.
 */
const HUB_PAGE_TYPES = new Set([
  'page',
  'flow',
  'task',
  'fs_item',
  'agent',
  'knowledge_base',
  'workspace',
]);

/**
 * The hub page for an entity: hub host + the hub's own dock pointer for it.
 * Null when there is no hub host (not cloud-connected) or the type has no hub
 * page — callers then leave the cloud glyph as a plain indicator.
 */
export function hubPageUrl(hubHost: string | null | undefined, ref: TypeId | null | undefined): string | null {
  if (!hubHost || !ref?.type || !ref?.id) return null;
  if (ref.type === 'project') return hubProjectUrl(hubHost, ref.id);
  if (!HUB_PAGE_TYPES.has(ref.type)) return null;
  return `${trimHubHost(hubHost)}/${ref.type}/${encodeURIComponent(ref.id)}`;
}
