import React from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';

export type EntityTypeFilter = 'all' | 'agent' | 'skill' | 'markdown' | 'spec' | 'whiteboard';

interface EntityTypeBarProps {
  /** The shown set of types. Empty = all types shown (every toggle lit). */
  selected: string[];
  /** Emits the new shown set. Empty means "all". */
  onChange: (next: string[]) => void;
  /** Optional per-type counts shown as a badge on each icon. */
  counts?: Partial<Record<string, number>>;
  /**
   * Types rendered as toggles. Limits the bar to the host's allowed/available
   * asset types — e.g. `['agent','skill']` for the run-with picker. Accepts a
   * readonly array so callers can pass a `readonly` enum list without copying.
   */
  allowed: readonly string[];
  /** Resolves the type-registry icon for a type name (e.g. `iconForType('skill')`). */
  iconForType: (type: string) => LucideIcon;
  /** Optional label resolver. Defaults to the built-in asset-type ``LABELS`` map. */
  labelForType?: (type: string) => string;
  /** ``data-testid`` prefix for the toggles (``<prefix>-<type>``, ``<prefix>-clear``). */
  testIdPrefix: string;
}

/**
 * Compact icon-toggle type filter. Each allowed type is an independent toggle;
 * its lit state always reflects what's actually visible. With nothing narrowed
 * every toggle is lit ("all shown"), mirroring the scope filter's "All" — so the
 * UI never looks disconnected from the result set. Clicking a lit toggle hides
 * that type; re-lighting them all collapses back to "all". `X` resets to all.
 */
export function EntityTypeBar({
  selected,
  onChange,
  counts,
  allowed,
  iconForType,
  labelForType,
  testIdPrefix,
}: EntityTypeBarProps): React.ReactElement {
  const { t } = useLingui();

  const LABELS: Record<string, string> = {
    agent: t`SubAgent`,
    skill: t`Skill`,
    markdown: t`Document`,
    spec: t`Spec`,
    whiteboard: t`Whiteboard`,
  };

  const allShown = selected.length === 0;
  const isActive = (t: string) => allShown || selected.includes(t);

  const toggle = (t: string) => {
    let next: string[];
    if (allShown)
      next = allowed.filter((x) => x !== t); // all → all-but-t
    else if (selected.includes(t))
      next = selected.filter((x) => x !== t); // hide t
    else next = [...selected, t]; // show t
    onChange(next.length === allowed.length ? [] : next); // full set ⇒ "all"
  };

  return (
    <div className="flex items-center gap-1">
      {allowed.map((t) => {
        const Icon = iconForType(t);
        const active = isActive(t);
        const count = counts?.[t];
        const showCount = typeof count === 'number' && count > 0;
        const label = labelForType ? labelForType(t) : (LABELS[t] ?? t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            title={showCount ? `${label} (${count})` : label}
            aria-pressed={active}
            className={cn(
              'relative flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
            data-testid={`${testIdPrefix}-${t}`}
          >
            <Icon className="h-4 w-4" />
            {showCount && (
              <span
                className={cn(
                  'absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none',
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
      {!allShown && (
        <button
          type="button"
          onClick={() => onChange([])}
          title={t`Show all types`}
          aria-label={t`Show all types`}
          className="ms-0.5 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          data-testid={`${testIdPrefix}-clear`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
