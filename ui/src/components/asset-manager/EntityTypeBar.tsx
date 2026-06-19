import React from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '@src/lib/utils';

export type EntityTypeFilter = 'all' | 'agent' | 'skill' | 'markdown' | 'spec' | 'whiteboard';

const LABELS: Record<string, string> = {
  agent: 'Agent',
  skill: 'Skill',
  markdown: 'Document',
  spec: 'Spec',
  whiteboard: 'Whiteboard',
};

interface EntityTypeBarProps {
  /** Active types. Empty = no type filter (all types visible). */
  selected: string[];
  /** Toggle one type on/off — independent of the others. */
  onToggle: (type: string) => void;
  /** Clear every active type (back to "all visible"). */
  onClear: () => void;
  /** Optional per-type counts shown as a badge on each icon. */
  counts?: Partial<Record<string, number>>;
  /**
   * Types rendered as toggles. Limits the bar to the host's allowed/available
   * asset types — e.g. `['agent','skill']` for the run-with picker — so it never
   * overflows with types that can't appear.
   */
  allowed: string[];
  /** Resolves the type-registry icon for a type name (e.g. `iconForType('skill')`). */
  iconForType: (type: string) => LucideIcon;
}

/**
 * Compact icon-toggle type filter for the asset picker. Each allowed type is an
 * **independent** square toggle (tooltip = type name, badge = count); any
 * combination can be active at once. A trailing clear-all (X) resets to the
 * default "all visible" state. Empty selection ⇒ no filtering.
 */
export function EntityTypeBar({
  selected,
  onToggle,
  onClear,
  counts,
  allowed,
  iconForType,
}: EntityTypeBarProps): React.ReactElement {
  return (
    <div className="flex items-center gap-1">
      {allowed.map((t) => {
        const Icon = iconForType(t);
        const isActive = selected.includes(t);
        const count = counts?.[t];
        const showCount = typeof count === 'number' && count > 0;
        const label = LABELS[t] ?? t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onToggle(t)}
            title={showCount ? `${label} (${count})` : label}
            aria-pressed={isActive}
            className={cn(
              'relative flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
            data-testid={`asset-picker-type-${t}`}
          >
            <Icon className="h-4 w-4" />
            {showCount && (
              <span
                className={cn(
                  'absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none',
                  isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          title="Clear type filter"
          aria-label="Clear type filter"
          className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          data-testid="asset-picker-type-clear"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
