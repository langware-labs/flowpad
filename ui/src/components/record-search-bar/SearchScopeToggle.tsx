import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import type React from 'react';

export type SearchScopeMode = 'all' | 'current';

interface SearchScopeToggleProps {
  value: SearchScopeMode;
  onChange: (next: SearchScopeMode) => void;
  allProjectCount: number;
  currentProjectAvailable: boolean;
  className?: string;
}

export function SearchScopeToggle({
  value,
  onChange,
  allProjectCount,
  currentProjectAvailable,
  className,
}: SearchScopeToggleProps): React.ReactElement {
  const options: ScopeBarOption<SearchScopeMode>[] = [
    {
      value: 'all',
      label: 'All projects',
      count: allProjectCount,
      title: 'Search all known projects',
    },
    {
      value: 'current',
      label: 'Current project',
      disabled: !currentProjectAvailable,
      title: currentProjectAvailable
        ? 'Search only the current project'
        : 'No current project is selected',
    },
  ];

  return (
    <ScopeBar
      value={value}
      options={options}
      onChange={onChange}
      className={className}
    />
  );
}
