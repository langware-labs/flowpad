import React, { useMemo } from 'react';
import { TypeId } from '@sdk';
import type { Project } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

interface ProjectChipProps {
  /** The owning project's id. Renders nothing when null/undefined or unresolved. */
  projectId: string | null | undefined;
  className?: string;
}

/**
 * Compact chip: the project's type-registry icon + its display name. Resolves
 * the Project by id (cached) and renders nothing until it resolves — so callers
 * can pass an id unconditionally. Shared by every surface that wants to show
 * which project the open content belongs to: the project-assets header, the
 * asset editor, the conversation header. The icon always comes from the type
 * registry via `iconForType('project')`, never hardcoded.
 */
export function ProjectChip({ projectId, className }: ProjectChipProps): React.ReactElement | null {
  const typeId = useMemo(() => (projectId ? new TypeId('project', projectId) : null), [projectId]);
  const { data: project } = useEntity<Project>(typeId);
  if (!project) return null;
  const Icon = iconForType('project');
  return (
    <div
      className={`flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground ${className ?? ''}`}
      title={project.displayName ?? undefined}
      data-testid="project-name-chip"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{project.displayName}</span>
    </div>
  );
}
