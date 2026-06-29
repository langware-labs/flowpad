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
  /** Icon rendered in `variant="icon"` mode (the square icon-only toggle). */
  icon?: React.ComponentType<{ className?: string }>;
}

interface ScopeBarProps<T extends string> {
  value: T;
  options: ScopeBarOption<T>[];
  onChange: (next: T) => void;
  /** Click handler for disabled options — useful for opening a picker modal. */
  onDisabledClick?: (value: T) => void;
  /** Optional trailing element (e.g. a filter-funnel button). */
  trailing?: React.ReactNode;
  /**
   * 'pill' (default) renders labeled pill toggles.
   * 'icon' renders square icon-only toggles (each option needs an `icon`).
   */
  variant?: 'pill' | 'icon';
  className?: string;
}

/**
 * Presentational toggle row used for scope/type filters. Domain-free —
 * AssetsPage wraps it with project-picker logic; AssetPickerPopover uses it
 * directly for both its scope and type filter rows.
 */
export function ScopeBar<T extends string>({
  value,
  options,
  onChange,
  onDisabledClick,
  trailing,
  variant = 'pill',
  className,
}: ScopeBarProps<T>): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        const showCount = typeof opt.count === 'number' && opt.count > 0;
        const onClick = () => {
          if (opt.disabled) {
            onDisabledClick?.(opt.value);
            return;
          }
          onChange(opt.value);
        };

        if (variant === 'icon') {
          const Icon = opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={onClick}
              title={opt.title}
              aria-pressed={isActive}
              className={cn(
                'relative flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                opt.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {showCount && (
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none',
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
        }

        return (
          <button
            key={opt.value}
            type="button"
            onClick={onClick}
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
