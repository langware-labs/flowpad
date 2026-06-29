import React from 'react';
import { Trans } from '@lingui/react/macro';
import { registerFilters, FilterState } from './filterRegistry';

const TaskFilters: React.FC<{ filters: FilterState; onChange: (f: FilterState) => void }> = ({ filters, onChange }) => (
  <select
    value={filters.status ?? ''}
    onChange={(e) => onChange({ ...filters, status: e.target.value })}
    className="h-8 rounded border border-input bg-background px-2 text-sm"
  >
    <option value=""><Trans>All statuses</Trans></option>
    <option value="to_do"><Trans>To Do</Trans></option>
    <option value="in_progress"><Trans>In Progress</Trans></option>
    <option value="done"><Trans>Done</Trans></option>
  </select>
);

registerFilters('task', TaskFilters);
export {};
