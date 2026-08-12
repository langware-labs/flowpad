import { i18n } from '@lingui/core';
/**
 * TimeCohortTabs - Pill-style tabs for selecting time periods.
 */

import { TIME_COHORTS, type TimeCohort } from './constants';

interface TimeCohortTabsProps {
  selected: TimeCohort;
  onSelect: (cohort: TimeCohort) => void;
}

export function TimeCohortTabs({ selected, onSelect }: TimeCohortTabsProps) {
  return (
    <div className="flex rounded-lg bg-muted p-0.5">
      {TIME_COHORTS.map((cohort) => (
        <button
          key={cohort.id}
          onClick={() => onSelect(cohort.id)}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-all ${
            selected === cohort.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {i18n._(cohort.label)}
        </button>
      ))}
    </div>
  );
}
