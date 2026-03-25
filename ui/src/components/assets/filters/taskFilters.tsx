import React from 'react';
import { registerFilters, FilterState } from './filterRegistry';

const TaskFilters: React.FC<{ filters: FilterState; onChange: (f: FilterState) => void }> = ({ filters, onChange }) => (
  <select
    value={filters.status ?? ''}
    onChange={(e) => onChange({ ...filters, status: e.target.value })}
    className="h-8 rounded border border-input bg-background px-2 text-sm"
  >
    <option value="">All statuses</option>
    <option value="to_do">To Do</option>
    <option value="in_progress">In Progress</option>
    <option value="done">Done</option>
  </select>
);

registerFilters('task', TaskFilters);
export {};
