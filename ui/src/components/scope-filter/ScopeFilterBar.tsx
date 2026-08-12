import { t } from '@lingui/core/macro';
import React, { useMemo } from 'react';
import { scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { useScopeFilterChips, type ScopeMode } from './useScopeFilterChips';

/**
 * Pill scope filter — single-select over All / User / Project / Selected.
 * All behavior lives in `useScopeFilterChips` (shared with ScopeFilterIconBar);
 * this is the labeled-pill rendering only.
 */
interface ScopeFilterBarProps {
  scope: ScopeFilter;
  currentProjectId: string | null;
  /** Current project display name — shown in the Project chip's tooltip. */
  currentProjectName?: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

export function ScopeFilterBar({
  scope,
  currentProjectId,
  currentProjectName,
  onScopeChange,
}: ScopeFilterBarProps): React.ReactElement {
  const {
    activeMode,
    selectedCount,
    projectDisabled,
    handleSelect,
    pickerOpen,
    setPickerOpen,
    onPickerConfirm,
  } = useScopeFilterChips({ scope, currentProjectId, onScopeChange });

  const options: ScopeBarOption<ScopeMode>[] = useMemo(() => [
    { value: 'all', label: t`All`, title: t`All assets (user + every project)` },
    { value: 'user', label: t`User`, title: t`User assets only` },
    {
      value: 'project',
      label: t`Project`,
      disabled: projectDisabled,
      title: projectDisabled
        ? 'No current project'
        : `Current project${currentProjectName ? `: ${currentProjectName}` : ''}`,
    },
    {
      value: 'selected',
      label: t`Selected`,
      count: activeMode === 'selected' ? selectedCount : undefined,
      title: t`Pick specific projects…`,
    },
  ], [projectDisabled, currentProjectName, activeMode, selectedCount]);

  return (
    <>
      <ScopeBar
        value={activeMode}
        options={options}
        onChange={handleSelect}
      />
      <ProjectPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={scopeProjectIds(scope)}
        onConfirm={onPickerConfirm}
      />
    </>
  );
}
