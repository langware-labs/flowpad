import React, { useMemo } from 'react';
import { Layers, User } from 'lucide-react';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { ScopeFilterFunnelButton } from './ScopeFilterFunnelButton';
import { useScopeFilterChips, type ChipKey } from './useScopeFilterChips';

/**
 * Icon-only scope filter — same hooks/model/data/context as ScopeFilterBar
 * (all chip↔scope semantics live in `useScopeFilterChips`), just a compact
 * square-icon presentation for the Assets sidebar. Four icons:
 * All (Layers) · User · Project (type-registry icon) · Filter (funnel → picker).
 */
interface ScopeFilterIconBarProps {
  scope: ScopeFilter;
  /** Seeded into the picker when "Project" is chosen with an empty picker. */
  currentProjectId: string | null;
  onScopeChange: (next: ScopeFilter) => void;
}

export function ScopeFilterIconBar({
  scope,
  currentProjectId,
  onScopeChange,
}: ScopeFilterIconBarProps): React.ReactElement {
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

  // Per the type-icon rule, the Project scope icon comes from the type registry.
  const ProjectIcon = iconForType('project');

  const options: ScopeBarOption<ChipKey>[] = useMemo(() => [
    {
      value: 'both',
      label: 'All',
      icon: Layers,
      title: 'All — user assets plus selected projects',
    },
    {
      value: 'user',
      label: 'User',
      icon: User,
      title: 'User assets only',
    },
    {
      value: 'project',
      label: 'Project',
      icon: ProjectIcon,
      count: projectCount,
      disabled: projectChipDisabled,
      title: projectChipDisabled
        ? 'Open the filter to pick projects'
        : 'Selected projects only',
    },
  ], [ProjectIcon, projectCount, projectChipDisabled]);

  return (
    <>
      <ScopeBar
        variant="icon"
        value={activeChip}
        options={options}
        onChange={handleChange}
        onDisabledClick={handleDisabledClick}
        trailing={<ScopeFilterFunnelButton onClick={() => setPickerOpen(true)} />}
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
