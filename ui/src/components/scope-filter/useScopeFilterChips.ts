import { useState } from 'react';
import type { ScopeFilter } from '@src/lib/scope-filter';

/**
 * Single source of truth for the scope-filter chip semantics, shared by the
 * pill ScopeFilterBar and the icon ScopeFilterIconBar. Everything works in
 * terms of the unified ScopeFilter shape — the chips are derived view state.
 *
 * Chip → ScopeFilter mapping:
 *   "User"    {user: true,  projects: cleared}  (else chipFor() reads as "All")
 *   "Project" {user: false, projects: keep current (or seed/picker)}
 *   "All"/both{user: true,  projects: keep current}
 */
export type ChipKey = 'user' | 'project' | 'both';

function chipFor(scope: ScopeFilter): ChipKey {
  if (scope.user && scope.projects.length > 0) return 'both';
  if (!scope.user && scope.projects.length > 0) return 'project';
  return 'user';
}

export interface UseScopeFilterChipsArgs {
  scope: ScopeFilter;
  currentProjectId: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

export interface UseScopeFilterChips {
  activeChip: ChipKey;
  projectCount: number;
  projectChipDisabled: boolean;
  handleChange: (next: ChipKey) => void;
  handleDisabledClick: (next: ChipKey) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  onPickerConfirm: (ids: string[]) => void;
}

export function useScopeFilterChips({
  scope,
  currentProjectId,
  onScopeChange,
}: UseScopeFilterChipsArgs): UseScopeFilterChips {
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeChip = chipFor(scope);
  const projectCount = scope.projects.length;
  const projectChipDisabled = projectCount === 0 && !currentProjectId;

  const handleChange = (next: ChipKey) => {
    if (next === 'user') {
      // "User" = user assets only (per the chip's label). Clear projects —
      // keeping them would yield {user:true, projects:[...]} which is the
      // "All" chip, so the user could never actually land on user-only.
      onScopeChange({ user: true, projects: [] });
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

  const onPickerConfirm = (ids: string[]) => {
    // Edit only the `projects` field. `user` stays whatever it was.
    // If the user just cleared the picker AND the active chip is "project",
    // we'd be in the degenerate {user:false, projects:[]} state — flip to
    // {user:true, projects:[]} (the "User" chip) to keep something selected.
    let nextUser = scope.user;
    if (ids.length === 0 && !scope.user) nextUser = true;
    onScopeChange({ user: nextUser, projects: ids });
    setPickerOpen(false);
  };

  return {
    activeChip,
    projectCount,
    projectChipDisabled,
    handleChange,
    handleDisabledClick,
    pickerOpen,
    setPickerOpen,
    onPickerConfirm,
  };
}
