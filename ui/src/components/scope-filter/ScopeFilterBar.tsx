import React, { useMemo } from 'react';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { ScopeFilterFunnelButton } from './ScopeFilterFunnelButton';
import { useScopeFilterChips, type ChipKey } from './useScopeFilterChips';

/**
 * Presentational top-bar that lets the user pick a ScopeFilter via three chips
 * (All / User / Project) plus a project-picker funnel. All chip↔scope semantics
 * live in `useScopeFilterChips` (shared with ScopeFilterIconBar) — this is the
 * pill rendering only.
 */
interface ScopeFilterBarProps {
  scope: ScopeFilter;
  /** Defaulted into the picker selection when scope='project' is chosen with
   *  an empty picker — keeps the "click Project, see current project" UX. */
  currentProjectId: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

export function ScopeFilterBar({
  scope,
  currentProjectId,
  onScopeChange,
}: ScopeFilterBarProps): React.ReactElement {
  const {
    activeChip,
    projectCount,
    projectChipDisabled,
    handleChange,
    handleDisabledClick,
    pickerOpen,
    setPickerOpen,
    onPickerConfirm,
  } = useScopeFilterChips({ scope, currentProjectId, onScopeChange });

  const options: ScopeBarOption<ChipKey>[] = useMemo(() => [
    {
      value: 'both',
      label: 'All',
      title: 'User assets plus selected projects',
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

  return (
    <>
      <ScopeBar
        value={activeChip}
        options={options}
        onChange={handleChange}
        onDisabledClick={handleDisabledClick}
        trailing={
          <ScopeFilterFunnelButton
            onClick={() => setPickerOpen(true)}
            className="ml-1"
            iconClassName="h-3.5 w-3.5"
          />
        }
      />
      <ProjectPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={scope.projects}
        onConfirm={onPickerConfirm}
      />
    </>
  );
}
