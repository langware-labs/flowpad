import React, { useMemo } from 'react';
import { Filter, Layers, User } from 'lucide-react';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useScopeFilterChips, type ScopeMode } from './useScopeFilterChips';

/**
 * Icon-only scope filter — same hook/model/data/context as ScopeFilterBar
 * (all behavior lives in `useScopeFilterChips`), compact square-icon
 * presentation for the Assets sidebar. Single-select, four icons:
 * All (Layers) · User · Project (type-registry icon) · Selected (funnel → picker).
 */
interface ScopeFilterIconBarProps {
  scope: ScopeFilter;
  currentProjectId: string | null;
  /** Current project display name — shown in the Project icon's tooltip. */
  currentProjectName?: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

export function ScopeFilterIconBar({
  scope,
  currentProjectId,
  currentProjectName,
  onScopeChange,
}: ScopeFilterIconBarProps): React.ReactElement {
  const {
    activeMode,
    selectedCount,
    projectDisabled,
    handleSelect,
    pickerOpen,
    setPickerOpen,
    onPickerConfirm,
  } = useScopeFilterChips({ scope, currentProjectId, onScopeChange });

  // Per the type-icon rule, the Project scope icon comes from the type registry.
  const ProjectIcon = useMemo(() => iconForType('project'), []);

  const options: ScopeBarOption<ScopeMode>[] = useMemo(() => [
    { value: 'all', label: 'All', icon: Layers, title: 'All assets (user + every project)' },
    { value: 'user', label: 'User', icon: User, title: 'User assets only' },
    {
      value: 'project',
      label: 'Project',
      icon: ProjectIcon,
      disabled: projectDisabled,
      title: projectDisabled
        ? 'No current project'
        : `Current project${currentProjectName ? `: ${currentProjectName}` : ''}`,
    },
    {
      value: 'selected',
      label: 'Selected',
      icon: Filter,
      count: activeMode === 'selected' ? selectedCount : undefined,
      title: 'Pick specific projects…',
    },
  ], [ProjectIcon, projectDisabled, currentProjectName, activeMode, selectedCount]);

  return (
    <>
      <ScopeBar
        variant="icon"
        value={activeMode}
        options={options}
        onChange={handleSelect}
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
