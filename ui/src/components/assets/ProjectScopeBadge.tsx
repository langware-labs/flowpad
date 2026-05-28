import React, { useMemo } from 'react';
import { Folder } from 'lucide-react';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { projectIdForPath } from './utils';

interface ProjectScopeBadgeProps {
  projectId: string;
}

function shortName(cwd: string | null | undefined, name: string | null | undefined): string {
  const raw = (cwd || name || '').replace(/\/+$/, '');
  if (!raw) return name || '';
  const parts = raw.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || raw;
  return parts.slice(-2).join('/');
}

/**
 * Read-only header chip rendered in place of ScopeFilterBar when AssetsPage
 * is hosted under `/dock/project/<id>`. Looks the project up by matching the
 * URL's synthetic project_id against `projectIdForPath(cwd)` — the same join
 * the picker and the indexer use, so a project entry will be found whenever
 * one exists.
 */
export function ProjectScopeBadge({ projectId }: ProjectScopeBadgeProps): React.ReactElement {
  const { projects } = useAllProjects();
  const label = useMemo(() => {
    const hit = projects.find((p) => projectIdForPath(p.cwd || p.name) === projectId);
    if (hit) return shortName(hit.cwd, hit.name);
    return projectId.slice(0, 8);
  }, [projects, projectId]);

  return (
    <div
      className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground"
      title={`Scoped to project ${label}`}
      data-testid="project-scope-badge"
    >
      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate">Project: {label}</span>
    </div>
  );
}
