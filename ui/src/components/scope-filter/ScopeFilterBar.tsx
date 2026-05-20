import React, { useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';

/**
 * Presentational top-bar that lets the user pick a ScopeFilter via three chips
 * (User / Project / Both) plus a project-picker funnel. Everything internally
 * works in terms of the unified ScopeFilter shape — the chips are derived view
 * state, not the source of truth.
 *
 * Chip → ScopeFilter mapping:
 *   "User"    {user: true,  projects: keep current}
 *   "Project" {user: false, projects: keep current (or fall through to picker)}
 *   "Both"    {user: true,  projects: keep current}
 *
 * The picker funnel is independent — it edits `projects` directly. So picking
 * "Project" with an empty picker opens the picker for the user.
 */
type ChipKey = 'user' | 'project' | 'both';

interface ScopeFilterBarProps {
  scope: ScopeFilter;
  /** Defaulted into the picker selection when scope='project' is chosen with
   *  an empty picker — keeps the "click Project, see current project" UX. */
  currentProjectId: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

function chipFor(scope: ScopeFilter): ChipKey {
  if (scope.user && scope.projects.length > 0) return 'both';
  if (!scope.user && scope.projects.length > 0) return 'project';
  return 'user';
}

export function ScopeFilterBar({
  scope,
  currentProjectId,
  onScopeChange,
}: ScopeFilterBarProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeChip = chipFor(scope);
  const projectCount = scope.projects.length;
  const projectChipDisabled = projectCount === 0 && !currentProjectId;

  const options: ScopeBarOption<ChipKey>[] = useMemo(() => [
    {
      value: 'both',
      label: 'Both',
      title: 'Both user assets and selected projects assets',
    },
    {
      value: 'user',
      label: 'User',
      title: 'User assets only',
    },
    {
      value: 'project',
      label: 'Project',
      count: projectCount,
      disabled: projectChipDisabled,
      title: projectChipDisabled
        ? 'Open the filter to pick projects'
        : 'Selected projects assets only',
    },
  ], [projectCount, projectChipDisabled]);

  const handleChange = (next: ChipKey) => {
    if (next === 'user') {
      onScopeChange({ user: true, projects: scope.projects });
      return;
    }
    if (next === 'project') {
      // If no projects in the filter yet, seed with current project (if any).
      const seed = scope.projects.length > 0
        ? scope.projects
        : (currentProjectId ? [currentProjectId] : []);
      onScopeChange({ user: false, projects: seed });
      return;
    }
    // 'both' — turn user on; keep projects (seed if empty so the chip is meaningful)
    const seed = scope.projects.length > 0
      ? scope.projects
      : (currentProjectId ? [currentProjectId] : []);
    onScopeChange({ user: true, projects: seed });
  };

  const handleDisabledClick = (next: ChipKey) => {
    if (next === 'project') setPickerOpen(true);
  };

  return (
    <>
      <ScopeBar
        value={activeChip}
        options={options}
        onChange={handleChange}
        onDisabledClick={handleDisabledClick}
        trailing={
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            title="Choose projects to filter by"
            aria-label="Project filter"
          >
            <Filter className="h-3.5 w-3.5" />
          </button>
        }
      />
      <ProjectPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={scope.projects}
        onConfirm={(ids) => {
          // Edit only the `projects` field. `user` stays whatever it was.
          // If user just cleared the picker AND the active chip is "project",
          // we'd be in the degenerate {user:false, projects:[]} state — flip
          // to {user:true, projects:[]} (the "User" chip) to keep something selected.
          let nextUser = scope.user;
          if (ids.length === 0 && !scope.user) nextUser = true;
          onScopeChange({ user: nextUser, projects: ids });
          setPickerOpen(false);
        }}
      />
    </>
  );
}
