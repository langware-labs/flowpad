import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useActiveTerminals, type TerminalTab } from '@src/hooks/useActiveTerminals';
import { Layers } from 'lucide-react';
import React, { useMemo, useState } from 'react';

interface ProjectsCounterChipProps {
  /** Project that the surrounding tab strip is currently scoped to. Used to highlight that row. */
  currentProjectId?: string | null;
}

interface Row {
  projectId: string;
  name: string;
  tabs: TerminalTab[];
}

function tabProjectId(tab: TerminalTab): string | null {
  return tab.shell?.project_id ?? tab.agenticProcess?.project_id ?? null;
}

function resolveProjectName(projectId: string): string {
  const project = Project.getByIdFromCache<Project>(projectId);
  return project?.getDisplayName() ?? project?.name ?? projectId.slice(0, 8);
}

export const ProjectsCounterChip: React.FC<ProjectsCounterChipProps> = ({ currentProjectId }) => {
  const [open, setOpen] = useState(false);
  const { data: tabs } = useActiveTerminals();

  const { rows, total } = useMemo(() => {
    const byProject = new Map<string, TerminalTab[]>();
    for (const tab of tabs) {
      const pid = tabProjectId(tab);
      if (!pid) continue;
      const bucket = byProject.get(pid);
      if (bucket) bucket.push(tab);
      else byProject.set(pid, [tab]);
    }
    const rows: Row[] = Array.from(byProject.entries()).map(([projectId, tabs]) => ({
      projectId,
      name: resolveProjectName(projectId),
      tabs,
    }));
    rows.sort((a, b) => {
      if (a.projectId === currentProjectId) return -1;
      if (b.projectId === currentProjectId) return 1;
      if (b.tabs.length !== a.tabs.length) return b.tabs.length - a.tabs.length;
      return a.name.localeCompare(b.name);
    });
    const total = rows.reduce((sum, r) => sum + r.tabs.length, 0);
    return { rows, total };
  }, [tabs, currentProjectId]);

  const isEmpty = total === 0;
  const tooltipText = `${total} active terminal${total === 1 ? '' : 's'} across all projects`;

  const chipClass = `mx-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium tabular-nums hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring ${
    isEmpty ? 'cursor-default opacity-50 hover:bg-background hover:text-foreground' : ''
  }`;

  if (isEmpty) {
    return (
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled
              data-testid="projects-counter-chip"
              className={chipClass}
              aria-label={tooltipText}
            >
              <Layers className="h-3 w-3" />
              {total}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltipText}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const handleSelect = async (row: Row) => {
    setOpen(false);
    const project = Project.getByIdFromCache<Project>(row.projectId);
    if (!project) return;
    // Pure context flip — TabbedTerminal self-heals: when its active shell
    // falls out of the new project's strip, it picks the first tab and
    // updates URL + activeShellId. Keeps this chip's concern minimal.
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      project.typeId,
    );
    dataContext.setWorkdir(project.fs_storage_mount_path ?? null);
  };

  return (
    <TooltipProvider delayDuration={400}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="projects-counter-chip"
                className={chipClass}
                aria-label={tooltipText}
              >
                <Layers className="h-3 w-3" />
                {total}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltipText}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-64 p-1"
          data-testid="projects-counter-popover"
        >
          <ul className="flex flex-col">
            {rows.map((row) => {
              const isCurrent = row.projectId === currentProjectId;
              return (
                <li key={row.projectId}>
                  <button
                    type="button"
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => handleSelect(row)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                      isCurrent ? 'bg-muted/60 font-medium' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                      {row.tabs.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
};
