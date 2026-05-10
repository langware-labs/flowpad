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

function arraysEqualAsSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

export function ScopeFilterBar({
  scope,
  projectIds,
  currentProjectId,
  onScopeChange,
  onProjectIdsChange,
}: ScopeFilterBarProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);

  const projectScopeDisabled = projectIds.length === 0;
  const customizedFromDefault =
    projectIds.length > 0 &&
    !(currentProjectId !== null && arraysEqualAsSets(projectIds, [currentProjectId]));

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
            className={`h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${
              scope === value
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {label}
          </button>
        );
      })}
      <button
        onClick={() => setPickerOpen(true)}
        className="relative ml-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        title="Choose projects to filter by"
        aria-label="Project filter"
      >
        <Filter className="h-3.5 w-3.5" />
        {customizedFromDefault && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
            {projectIds.length}
          </span>
        )}
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
