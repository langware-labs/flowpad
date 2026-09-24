import React from 'react';
import { Trans } from '@lingui/react/macro';
import { statusLabel } from '@src/components/task-bar/constants';
import { ALL_TASK_STATUSES } from '@src/components/task-bar/task-utils';
import { registerFilters, FilterState } from './filterRegistry';

const TaskFilters: React.FC<{ filters: FilterState; onChange: (f: FilterState) => void }> = ({ filters, onChange }) => (
  <select
    value={filters.status ?? ''}
    onChange={(e) => onChange({ ...filters, status: e.target.value })}
    className="h-8 rounded border border-input bg-background px-2 text-sm"
  >
    <option value="">
      <Trans>All statuses</Trans>
    </option>
    {ALL_TASK_STATUSES.map((status) => (
      <option key={status} value={status}>
        {statusLabel(status)}
      </option>
    ))}
  </select>
);

registerFilters('task', TaskFilters);
export {};
