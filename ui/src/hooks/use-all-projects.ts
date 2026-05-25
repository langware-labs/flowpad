import { type ProjectListItem } from '@sdk';
import { useClaudeProjectList } from './use-claude-projects';

interface UseAllProjectsOptions {
  /** When false, the underlying scan is skipped. */
  enabled?: boolean;
  /** When true, also include SDK-shipped system projects (Flowpad Assistant etc.). */
  includeSystem?: boolean;
}

/**
 * Unified project list for any picker. THIN wrapper over the backend's
 * ``list_projects_from_indexer`` (served via ``listProjectsFromComputeNode``),
 * which is itself a thin wrapper over ``get_all_projects`` — the single source
 * of truth that already merges:
 *
 *   1. Claude scan   (~/.claude/projects/<encoded>/)
 *   2. Codex scan    (~/.codex/config.toml + rollout JSONLs)
 *   3. Project entity table (flowpad-registered projects)
 *
 * deduped by canonical posix cwd. No client-side merge needed anymore —
 * previous versions of this hook unioned three separate sources because the
 * backend lacked a single function for it.
 */
export function useAllProjects({
  enabled = true,
  includeSystem = false,
}: UseAllProjectsOptions = {}) {
  const { projects, isLoading } = useClaudeProjectList({ enabled });
  const filtered: ProjectListItem[] = includeSystem
    ? projects
    : projects.filter((p) => !(p as ProjectListItem & { system?: boolean }).system);
  return { projects: filtered, isLoading };
}
