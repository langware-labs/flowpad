/**
 * TaskStatusTabs - Pill-style tabs for Active / Pending / Archived.
 * Replicates the TimeCohortTabs pattern.
 */

import { TASK_TABS, type TaskTab } from './constants';

interface TaskStatusTabsProps {
  selected: TaskTab;
  onSelect: (tab: TaskTab) => void;
}

export function TaskStatusTabs({ selected, onSelect }: TaskStatusTabsProps) {
  return (
    <div className="flex rounded-lg bg-muted p-0.5">
      {TASK_TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-all ${
            selected === tab.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
