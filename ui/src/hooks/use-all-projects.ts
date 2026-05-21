import { type ProjectListItem } from '@sdk';
import apiClient from '@sdk/client';
import { useEffect, useMemo, useState } from 'react';
import { useClaudeProjectList } from './use-claude-projects';
import { useProjects } from './use-projects';

interface UseAllProjectsOptions {
  /** When false, Claude scans + system fetch are skipped. Flowpad list still loads. */
  enabled?: boolean;
  /** When true, also fetches SDK-shipped system projects (e.g. Flowpad Assistant). */
  includeSystem?: boolean;
}

interface SystemProjectRow {
  id: string;
  name: string;
  fs_storage_mount_path?: string;
  displayName?: string;
}

const normalizePath = (path: string): string => {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

const canonicalPathKey = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  return normalized.replace(/^\/+/, '') || normalized;
};

/**
 * Unified project list for any picker. Merges Flowpad `Project` entities with
 * Claude-scanned project folders (and optionally SDK system projects), deduped
 * by canonical filesystem path. Use this everywhere instead of `useProjects()`
 * + a parallel scan so every picker sees the same set.
 */
export function useAllProjects({
  enabled = true,
  includeSystem = false,
}: UseAllProjectsOptions = {}) {
  const { projects: claudeScans, isLoading: isLoadingClaude } = useClaudeProjectList({ enabled });
  const { projects: flowpadProjects, isLoading: isLoadingFlowpad } = useProjects();
  const [systemProjects, setSystemProjects] = useState<SystemProjectRow[]>([]);

  useEffect(() => {
    if (!enabled || !includeSystem) {
      setSystemProjects([]);
      return;
    }
    apiClient
      .get('/graph/project/?include_system=true')
      .then((data: unknown) => {
        const list = Array.isArray((data as { data?: unknown[] })?.data)
          ? ((data as { data: unknown[] }).data as Array<Record<string, unknown>>)
          : Array.isArray(data)
            ? (data as unknown as Array<Record<string, unknown>>)
            : [];
        setSystemProjects(
          list
            .filter((p) => !!p.system)
            .map((p) => ({
              id: String(p.id ?? ''),
              name: String(p.name ?? ''),
              fs_storage_mount_path:
                typeof p.fs_storage_mount_path === 'string' ? p.fs_storage_mount_path : undefined,
              displayName: typeof p.name === 'string' ? p.name : undefined,
            })),
        );
      })
      .catch(() => setSystemProjects([]));
  }, [enabled, includeSystem]);

  const merged = useMemo((): ProjectListItem[] => {
    const byPath = new Map<string, ProjectListItem>();

    const upsert = (item: ProjectListItem) => {
      const key = item.cwd ? canonicalPathKey(normalizePath(item.cwd)) : null;
      if (!key) return;
      const existing = byPath.get(key);
      // Keep entry with more sessions; on tie prefer non-null modified_at.
      if (
        !existing ||
        item.session_count > existing.session_count ||
        (item.session_count === existing.session_count && item.modified_at && !existing.modified_at)
      ) {
        byPath.set(key, item);
      }
    };

    for (const p of claudeScans) upsert(p);

    for (const p of flowpadProjects ?? []) {
      const path = p.fs_storage_mount_path;
      if (!path || !p.name) continue;
      if (/[/\\](\.flow|flow\/sessions|flow\/records)[/\\]/.test(path)) continue;
      upsert({
        id: `flowpad:${p.id}`,
        name: p.displayName,
        encoded_name: p.id,
        cwd: path,
        session_count: 0,
        claude_session_count: 0,
        codex_session_count: 0,
        claude: false,
        codex: false,
        worker_types: [],
        modified_at: null,
      });
    }

    for (const p of systemProjects) {
      const path = p.fs_storage_mount_path;
      if (!path || !p.name) continue;
      upsert({
        id: `flowpad:${p.id}`,
        name: p.displayName || p.name,
        encoded_name: p.id,
        cwd: path,
        session_count: 0,
        claude_session_count: 0,
        codex_session_count: 0,
        claude: false,
        codex: false,
        worker_types: [],
        modified_at: null,
        system: true,
      });
    }

    return Array.from(byPath.values());
  }, [claudeScans, flowpadProjects, systemProjects]);

  return {
    projects: merged,
    isLoading: isLoadingClaude || isLoadingFlowpad,
  };
}
