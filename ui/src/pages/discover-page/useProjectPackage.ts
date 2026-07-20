import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { dataContext } from '@sdk';
import { applyScopeToParams, projectScope } from '@src/lib/scope-filter';
import type { SearchResult } from '@src/hooks/use-asset-search';

// Local leaf copy (like the ~7 others across the tree): keeps this data hook
// dependency-light — the shared asset-row-helpers.basename drags in EntityChip
// + navigation, which would couple the hook to heavy UI and break unit isolation.
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Read-side model for the Discover page: the CURRENT project's assets — its
 * "what's in the box". Goes straight to the backend `/search` endpoint scoped
 * to the active project (`dataContext.project`) and normalizes each hit to a
 * display-ready {@link PackageItem}. No fixtures, no marketplace fields —
 * only what the backend actually knows.
 *
 * `record_type` on `/search` is single-valued, so we fan out one request per
 * asset type and merge (mirrors the default set `Project.get_assets_action`
 * uses server-side: skill / agent / spec / markdown). `projectScope` keeps the
 * result to records owned by THIS project (scope=project ∩ project_id), rather
 * than everything globally visible to it.
 */

/** Asset types that make up a project's box. Mirrors the backend get-assets default. */
export const PACKAGE_ASSET_TYPES = ['skill', 'agent', 'spec', 'markdown'] as const;

const PER_TYPE_LIMIT = 500;

export interface PackageItem {
  /** Entity type — the join key for `iconForType` / `labelForType`. */
  type: string;
  /** Entity record id. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description; may be empty. */
  description: string;
  /** Record scope (project / user / system). */
  scope: string;
  /** On-disk path, when file-backed. */
  path: string | null;
}

export interface UseProjectPackageResult {
  projectId: string | null;
  projectName: string | null;
  items: PackageItem[];
  isLoading: boolean;
}

function toItem(r: SearchResult): PackageItem {
  const path = r.asset_ref || r.file_path || null;
  return {
    type: r.record_type,
    id: r.record_id,
    name: r.title || r.name || (path ? basename(path) : '') || '(untitled)',
    description: r.description || r.snippet || '',
    scope: r.scope,
    path,
  };
}

async function fetchType(typeName: string, projectId: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ record_type: typeName, q: '', offset: '0', limit: String(PER_TYPE_LIMIT) });
  applyScopeToParams(params, projectScope(projectId));
  try {
    const data = (await apiClient.get(`/search?${params.toString()}`)) as { results?: SearchResult[] } | null;
    return data?.results ?? [];
  } catch {
    return [];
  }
}

export function useProjectPackage(): UseProjectPackageResult {
  // The active project is read once on mount — Discover is a full-page route
  // opened for the current project (dataContext is not reactive; see
  // project_contextprocess_not_reactive).
  const project = dataContext.project ?? null;
  const projectId = project?.typeId?.id ?? null;
  const projectName = project?.getDisplayName?.() ?? project?.name ?? null;

  const [items, setItems] = useState<PackageItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(!!projectId);

  useEffect(() => {
    if (!projectId) {
      setItems([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const perType = await Promise.all(PACKAGE_ASSET_TYPES.map((t) => fetchType(t, projectId)));
        if (!cancelled) setItems(perType.flatMap((rows) => rows.map(toItem)));
      } catch (err) {
        console.error('[useProjectPackage] failed', err);
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { projectId, projectName, items, isLoading };
}
