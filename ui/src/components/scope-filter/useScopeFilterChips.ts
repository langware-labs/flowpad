import { useState } from 'react';
import {
  ALL_SCOPE_FILTER,
  defaultScopeFilter,
  scopeFilterEqual,
  type ScopeFilter,
} from '@src/lib/scope-filter';

/**
 * Single source of truth for the scope-filter behavior, shared by the pill
 * ScopeFilterBar and the icon ScopeFilterIconBar. Strict single-select over
 * four mutually-exclusive modes — whatever is marked is active, no cross
 * logic between modes:
 *
 *   "all"      → everything ({all:true})
 *   "user"     → user assets only ({user:true, projects:[]})
 *   "project"  → the current project only ({user:false, projects:[currentId]})
 *   "selected" → explicitly-picked projects ({user:false, projects:[...]})
 *
 * `project` always means the current project (never the picker selection);
 * `selected` is driven by the project picker.
 */
export type ScopeMode = 'all' | 'user' | 'project' | 'selected';

function modeFor(scope: ScopeFilter, currentProjectId: string | null): ScopeMode {
  if (scope.all) return 'all';
  if (!scope.user && scope.projects.length > 0) {
    // "Project" = exactly the current project; anything else is "Selected".
    // Reuse scopeFilterEqual so the comparison stays canonical.
    return currentProjectId && scopeFilterEqual(scope, defaultScopeFilter(currentProjectId))
      ? 'project'
      : 'selected';
  }
  // {user:true, projects:[]} and any non-canonical state read as "user".
  return 'user';
}

export interface UseScopeFilterChipsArgs {
  scope: ScopeFilter;
  currentProjectId: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

export interface UseScopeFilterChips {
  activeMode: ScopeMode;
  /** Count of explicitly-selected projects (for the "Selected" badge). */
  selectedCount: number;
  /** "Project" mode needs a current project to point at. */
  projectDisabled: boolean;
  /** Single-select handler. `selected` opens the picker instead of applying. */
  handleSelect: (mode: ScopeMode) => void;
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

  const activeMode = modeFor(scope, currentProjectId);
  const selectedCount = scope.all ? 0 : scope.projects.length;
  const projectDisabled = !currentProjectId;

  const handleSelect = (mode: ScopeMode) => {
    switch (mode) {
      case 'all':
        onScopeChange({ ...ALL_SCOPE_FILTER });
        return;
      case 'user':
        onScopeChange({ user: true, projects: [] });
        return;
      case 'project':
        if (currentProjectId) onScopeChange({ user: false, projects: [currentProjectId] });
        return;
      case 'selected':
        // Pick which projects first; scope applies on confirm.
        setPickerOpen(true);
        return;
    }
  };

  const onPickerConfirm = (ids: string[]) => {
    // Empty selection falls back to "All" so the view is never left empty.
    onScopeChange(ids.length === 0 ? { ...ALL_SCOPE_FILTER } : { user: false, projects: ids });
    setPickerOpen(false);
  };

  return {
    activeMode,
    selectedCount,
    projectDisabled,
    handleSelect,
    pickerOpen,
    setPickerOpen,
    onPickerConfirm,
  };
}
