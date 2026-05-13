import React, { useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import type { AssetScope } from './assetFilter';
import { ProjectPickerModal } from './ProjectPickerModal';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';

interface ScopeFilterBarProps {
  scope: AssetScope;
  projectIds: string[];
  currentProjectId: string | null;
  onScopeChange: (scope: AssetScope) => void;
  onProjectIdsChange: (ids: string[]) => void;
}

export function ScopeFilterBar({
  scope,
  projectIds,
  currentProjectId,
  onScopeChange,
  onProjectIdsChange,
}: ScopeFilterBarProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);

  const effectiveProjectIds = useMemo(() => {
    if (projectIds.length > 0) return projectIds;
    if (currentProjectId) return [currentProjectId];
    return [];
  }, [currentProjectId, projectIds]);
  const projectScopeDisabled = effectiveProjectIds.length === 0;
  const projectCount = effectiveProjectIds.length;

  const options: ScopeBarOption<AssetScope>[] = [
    {
      value: 'all',
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
      disabled: projectScopeDisabled,
      title: projectScopeDisabled
        ? 'Open the filter to pick projects'
        : 'Selected projects assets only',
    },
  ];

  const handleChange = (next: AssetScope) => {
    if (next === 'project' && projectIds.length === 0 && currentProjectId) {
      onProjectIdsChange([currentProjectId]);
    }
    onScopeChange(next);
  };

  const handleDisabledClick = (next: AssetScope) => {
    if (next === 'project') setPickerOpen(true);
  };

  return (
    <>
      <ScopeBar
        value={scope}
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
        selectedIds={effectiveProjectIds}
        onConfirm={(ids) => {
          onProjectIdsChange(ids);
          setPickerOpen(false);
          if (ids.length === 0 && scope === 'project') {
            onScopeChange('all');
          }
        }}
      />
    </>
  );
}
