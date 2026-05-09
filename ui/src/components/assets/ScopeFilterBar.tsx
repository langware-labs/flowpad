import React, { useState } from 'react';
import type { AssetScope } from './assetFilter';
import { ProjectPickerModal } from './ProjectPickerModal';

interface ScopeFilterBarProps {
  scope: AssetScope;
  projectIds: string[];
  onScopeChange: (scope: AssetScope) => void;
  onProjectIdsChange: (ids: string[]) => void;
  includeSystem?: boolean;
  onIncludeSystemChange?: (next: boolean) => void;
}

const SCOPES: { value: AssetScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'project', label: 'Project' },
];

export function ScopeFilterBar({
  scope,
  projectIds,
  onScopeChange,
  onProjectIdsChange,
  includeSystem = false,
  onIncludeSystemChange,
}: ScopeFilterBarProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleScopeClick = (s: AssetScope) => {
    if (s === 'project') {
      if (scope === 'project') {
        // already active — re-open picker to edit selection
        setPickerOpen(true);
      } else {
        onScopeChange('project');
        setPickerOpen(true);
      }
      return;
    }
    onScopeChange(s);
    onProjectIdsChange([]);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onScopeChange('all');
    onProjectIdsChange([]);
  };

  return (
    <div className="flex items-center gap-1">
      {SCOPES.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => handleScopeClick(value)}
          className={`h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${
            scope === value
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          }`}
        >
          {label}
          {value === 'project' && scope === 'project' && projectIds.length > 0 && (
            <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              {projectIds.length}
            </span>
          )}
        </button>
      ))}
      {scope === 'project' && (
        <button
          onClick={handleClear}
          className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Clear project filter"
        >
          ×
        </button>
      )}
      {onIncludeSystemChange && (
        <label
          className="ml-2 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Show entities shipped in the Flowpad Assistant system project"
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-input"
            checked={includeSystem}
            onChange={(e) => onIncludeSystemChange(e.target.checked)}
          />
          Show system
        </label>
      )}
      <ProjectPickerModal
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open && projectIds.length === 0) {
            onScopeChange('all');
          }
        }}
        selectedIds={projectIds}
        onConfirm={(ids) => {
          onProjectIdsChange(ids);
          setPickerOpen(false);
          if (ids.length === 0) {
            onScopeChange('all');
          }
        }}
      />
    </div>
  );
}
