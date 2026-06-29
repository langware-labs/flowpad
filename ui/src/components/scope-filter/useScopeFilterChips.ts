import { useState } from 'react';
import {
  allScope,
  filterScope,
  projectScope,
  scopeProjectIds,
  userScope,
  type ScopeFilter,
} from '@src/lib/scope-filter';

/**
 * Single source of truth for the scope-filter behavior, shared by the pill
 * ScopeFilterBar and the icon ScopeFilterIconBar. Strict single-select over
 * four mutually-exclusive modes — whatever is marked is active, no cross
 * logic between modes:
 *
 *   "all"      → everything ({mode:'all'})
 *   "user"     → user assets only ({mode:'user'})
 *   "project"  → the current project only ({mode:'project', activeProjectId})
 *   "selected" → explicitly-picked projects ({mode:'filter', projects:[...]})
 *
 * The active chip reads straight off `scope.mode` — `filter` surfaces as the
 * "Selected" chip. No inference from field combinations, so "Project" (the
 * active-project context) and "Selected" (an ad-hoc pick of one project) never
 * get confused, even when they select the same single project.
 */
export type ScopeMode = 'all' | 'user' | 'project' | 'selected';

function modeFor(scope: ScopeFilter): ScopeMode {
  return scope.mode === 'filter' ? 'selected' : scope.mode;
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

  const activeMode = modeFor(scope);
  const selectedCount = scope.mode === 'filter' ? scopeProjectIds(scope).length : 0;
  const projectDisabled = !currentProjectId;

  const handleSelect = (mode: ScopeMode) => {
    switch (mode) {
      case 'all':
        onScopeChange(allScope());
        return;
      case 'user':
        onScopeChange(userScope());
        return;
      case 'project':
        if (currentProjectId) onScopeChange(projectScope(currentProjectId));
        return;
      case 'selected':
        // Pick which projects first; scope applies on confirm.
        setPickerOpen(true);
        return;
    }
  };

  const onPickerConfirm = (ids: string[]) => {
    // Empty selection falls back to "All" so the view is never left empty.
    onScopeChange(ids.length === 0 ? allScope() : filterScope(false, ids));
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
