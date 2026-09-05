import { Trans } from '@lingui/react/macro';
import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Globe } from 'lucide-react';
import React from 'react';
import { ProjectListPopoverContent, ProjectScopeSummary, useProjectListMenu } from './project-list-menu';

interface ProjectsCounterChipProps {
  /** Project that the surrounding tab strip is currently scoped to. Used to highlight that row. */
  currentProjectId?: string | null;
  /**
   * Display name of the current project, shown as a chip alongside the counts.
   * Optional: the chip falls back to the matching open bucket's name, so a
   * project with live terminals still labels itself even without this prop.
   */
  currentProjectName?: string | null;
}

/**
 * The advanced tab strip's project chip: the current scope's name plus the
 * open-projects count, opening the shared project list on click. The list
 * itself (buckets, ordering, URL-first selection) lives in
 * `project-list-menu` and is shared with the navigation bar's chip.
 */
export const ProjectsCounterChip: React.FC<ProjectsCounterChipProps> = ({ currentProjectId, currentProjectName }) => {
  const menu = useProjectListMenu({ currentProjectId, currentProjectName });
  const { projectName, scopeLabel, projectTotal, isGlobalScope, summaryLabel } = menu;
  const hasProject = !!projectName;
  // Nothing to advertise: no scope to name, or no project owns a tab and we're
  // not in a populated Global scope. Either way the chip stays hidden.
  const isEmpty = !scopeLabel || (projectTotal === 0 && !isGlobalScope);

  // Two scope treatments within one design language (height, radius, border
  // weight): a PROJECT scope reads as a subtle primary-tinted pill; the GLOBAL
  // scope gets a distinct violet accent so it never looks like a regular project.
  const chipClass = `ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 self-center rounded-md border px-2.5 text-xs font-medium tabular-nums focus:outline-none focus:ring-1 focus:ring-ring ${
    hasProject
      ? 'border-primary/30 bg-primary/5 text-foreground hover:bg-primary/10'
      : 'border-violet-500/30 bg-violet-500/5 text-foreground hover:bg-violet-500/10'
  }`;

  // Per-type icon from the backend TypeInfo registry (CLAUDE.md: never hardcode
  // a glyph for an entity type) — the same project icon every other surface shows.
  // Global is a pseudo-scope (not an entity type), so it uses a plain `Globe` glyph.
  const ProjectIcon = iconForType(Project.type);

  // Trigger content: the scope label (project name, or "Global") with its accent
  // glyph, then the OPEN-PROJECTS count behind a divider — the per-type project
  // glyph paired with its number so the meaning is unambiguous. The open-TABS
  // count is deliberately not painted here; it lives in the hover tooltip (and
  // the aria-label), spelled out.
  const triggerContent = (
    <>
      {hasProject ? (
        <>
          <ProjectIcon className="h-3 w-3 shrink-0 text-primary" />
          <span className="max-w-[9rem] truncate">{projectName}</span>
        </>
      ) : (
        <>
          <Globe className="h-3 w-3 shrink-0 text-violet-500" />
          <span className="max-w-[9rem] truncate">
            <Trans>Global</Trans>
          </span>
        </>
      )}
      <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-border" />
      <span className="inline-flex items-center gap-1">
        <ProjectIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        {projectTotal}
      </span>
    </>
  );

  // No project owns any open tab (buckets empty ⇒ both counts are 0). Even when
  // an ambient active project still resolves a name, a "<project> · 0 / 0" chip
  // represents nothing — a strip whose only tabs are global has no project tab
  // to count — so the chip stays hidden rather than advertising "0,0".
  if (isEmpty) return null;

  return (
    <TooltipProvider delayDuration={400}>
      <Popover open={menu.open} onOpenChange={menu.setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button type="button" data-testid="projects-counter-chip" className={chipClass} aria-label={summaryLabel}>
                {triggerContent}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              <ProjectScopeSummary menu={menu} />
            </div>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-72 p-1"
          data-testid="projects-counter-popover"
        >
          <ProjectListPopoverContent menu={menu} />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
};
