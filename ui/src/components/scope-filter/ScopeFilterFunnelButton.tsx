import React from 'react';
import { Filter } from 'lucide-react';
import { cn } from '@src/lib/utils';

/**
 * The project-picker funnel shared by ScopeFilterBar (pill) and
 * ScopeFilterIconBar (icon). Same action + styling everywhere — callers only
 * tweak spacing/icon size via `className` / `iconClassName`.
 */
export function ScopeFilterFunnelButton({
  onClick,
  className,
  iconClassName,
}: {
  onClick: () => void;
  className?: string;
  iconClassName?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
        className,
      )}
      title="Choose projects to filter by"
      aria-label="Project filter"
    >
      <Filter className={cn('h-4 w-4', iconClassName)} />
    </button>
  );
}
