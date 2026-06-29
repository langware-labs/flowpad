import React, { useMemo } from 'react';
import { Folder } from 'lucide-react';
import { useAllProjects } from '@src/hooks/use-all-projects';

interface ProjectNameChipProps {
  /** Absolute on-disk path of the asset being viewed. */
  sourcePath: string;
}

function shortName(cwd: string | null | undefined, name: string | null | undefined): string {
  const raw = (cwd || name || '').replace(/\/+$/, '');
  return raw.split('/').pop() || name || '';
}

/**
 * Small read-only chip rendered next to the asset file name showing which
 * project the file lives under. The owning project is the one whose `cwd` is
 * the longest path-prefix of the asset's source path. Renders nothing when the
 * file doesn't sit under any known project.
 */
export function ProjectNameChip({ sourcePath }: ProjectNameChipProps): React.ReactElement | null {
  const { projects } = useAllProjects();
  const project = useMemo(() => {
    if (!sourcePath) return null;
    let best: { cwd: string; name: string } | null = null;
    for (const p of projects) {
      const cwd = (p.cwd || '').replace(/\/+$/, '');
      if (!cwd) continue;
      if (sourcePath === cwd || sourcePath.startsWith(`${cwd}/`)) {
        if (!best || cwd.length > best.cwd.length) best = { cwd, name: p.name };
      }
    }
    return best;
  }, [projects, sourcePath]);

  if (!project) return null;
  const label = shortName(project.cwd, project.name);

  return (
    <span
      className="flex h-5 flex-shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground"
      title={`Project: ${project.cwd}`}
      data-testid="asset-project-chip"
    >
      <Folder className="h-3 w-3" />
      <span className="max-w-[120px] truncate">{label}</span>
    </span>
  );
}
