import React from 'react';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';

export type EntityTypeFilter = 'all' | 'agent' | 'skill' | 'markdown' | 'spec' | 'whiteboard';

interface EntityTypeBarProps {
  value: EntityTypeFilter;
  onChange: (next: EntityTypeFilter) => void;
  /** Optional per-type counts. When provided, an option's count shows next to its label. */
  counts?: Partial<Record<EntityTypeFilter, number>>;
}

const OPTIONS: { value: EntityTypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'agent', label: 'Agent' },
  { value: 'skill', label: 'Skill' },
  { value: 'markdown', label: 'Document' },
  { value: 'spec', label: 'Spec' },
  { value: 'whiteboard', label: 'Whiteboard' },
];

export function EntityTypeBar({ value, onChange, counts }: EntityTypeBarProps): React.ReactElement {
  const options: ScopeBarOption<EntityTypeFilter>[] = OPTIONS.map((o) => ({
    ...o,
    count: counts?.[o.value],
  }));
  return <ScopeBar value={value} options={options} onChange={onChange} />;
}
