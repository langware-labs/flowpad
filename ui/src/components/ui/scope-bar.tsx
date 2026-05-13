import React from 'react';
import { cn } from '@src/lib/utils';

export interface ScopeBarOption<T extends string> {
  value: T;
  label: string;
  /** Optional count chip rendered next to the label (e.g., "Project 3"). */
  count?: number;
  /** Disable the option (renders muted; still focusable for the title hint). */
  disabled?: boolean;
  /** Hover title; useful for explaining a disabled state. */
  title?: string;
}

interface ScopeBarProps<T extends string> {
  value: T;
  options: ScopeBarOption<T>[];
  onChange: (next: T) => void;
  /** Click handler for disabled options — useful for opening a picker modal. */
  onDisabledClick?: (value: T) => void;
  /** Optional trailing element (e.g. a filter-funnel button). */
  trailing?: React.ReactNode;
  className?: string;
}

/**
 * Presentational pill-toggle row used for scope/type filters. Domain-free —
 * AssetsPage wraps it with project-picker logic; AssetPickerPopover uses it
 * directly for both its scope and type filter rows.
 */
export function ScopeBar<T extends string>({
  value,
  options,
  onChange,
  onDisabledClick,
  trailing,
  className,
}: ScopeBarProps<T>): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        const showCount = typeof opt.count === 'number' && opt.count > 0;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              if (opt.disabled) {
                onDisabledClick?.(opt.value);
                return;
              }
              onChange(opt.value);
            }}
            title={opt.title}
            aria-pressed={isActive}
            className={cn(
              'flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              opt.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {opt.label}
            {showCount && (
              <span
                className={cn(
                  'inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px]',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}
