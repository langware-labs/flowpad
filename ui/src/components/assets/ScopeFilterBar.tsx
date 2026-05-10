import React, { useState } from 'react';
import { Filter } from 'lucide-react';
import type { AssetScope } from './assetFilter';
import { ProjectPickerModal } from './ProjectPickerModal';

interface ScopeFilterBarProps {
  scope: AssetScope;
  projectIds: string[];
  currentProjectId: string | null;
  onScopeChange: (scope: AssetScope) => void;
  onProjectIdsChange: (ids: string[]) => void;
}

const SCOPES: { value: AssetScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'project', label: 'Project' },
];

export function ScopeFilterBar({
  scope,
  projectIds,
  currentProjectId: _currentProjectId,
  onScopeChange,
  onProjectIdsChange,
}: ScopeFilterBarProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);

  const projectScopeDisabled = projectIds.length === 0;
  const projectCount = projectIds.length;

  const handleScopeClick = (s: AssetScope) => {
    if (s === 'project' && projectScopeDisabled) {
      setPickerOpen(true);
      return;
    }
    onScopeChange(s);
  };

  return (
    <div className="flex items-center gap-1">
      {SCOPES.map(({ value, label }) => {
        const disabled = value === 'project' && projectScopeDisabled;
        const showCount = value === 'project' && projectCount > 0;
        const isActive = scope === value;
        return (
          <button
            key={value}
            onClick={() => handleScopeClick(value)}
            disabled={disabled}
            title={
              disabled
                ? 'Open the filter to pick projects'
                : undefined
            }
            className={`flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {label}
            {showCount && (
              <span
                className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {projectCount}
              </span>
            )}
          </button>
        );
      })}
      <button
        onClick={() => setPickerOpen(true)}
        className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        title="Choose projects to filter by"
        aria-label="Project filter"
      >
        <Filter className="h-3.5 w-3.5" />
      </button>
      <ProjectPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={projectIds}
        onConfirm={(ids) => {
          onProjectIdsChange(ids);
          setPickerOpen(false);
          if (ids.length === 0 && scope === 'project') {
            onScopeChange('all');
          }
        }}
      />
    </div>
  );
}
