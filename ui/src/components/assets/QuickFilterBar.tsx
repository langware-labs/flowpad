import React from 'react';
import { getFilters, FilterState } from './filters/filterRegistry';

interface Props {
  recordType: string;
  filters: FilterState;
  onChange: (f: FilterState) => void;
}

export function QuickFilterBar({ recordType, filters, onChange }: Props) {
  const TypeFilters = getFilters(recordType);
  return (
    <div className="flex items-center gap-2">
      {TypeFilters && <TypeFilters filters={filters} onChange={onChange} />}
    </div>
  );
}
