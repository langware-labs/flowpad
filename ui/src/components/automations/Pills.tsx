/**
 * The Automations screen's one choice control: a row of pills, one selected.
 * Used for schedule presets, the Then choice, kind filters and run results —
 * one look, one keyboard model (a radiogroup), one place to restyle.
 */
import type { ReactNode } from 'react';
import { cn } from '@src/lib/utils';

export interface PillOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function Pills<T extends string>({
  value,
  options,
  onChange,
  disabled,
  testId,
  label,
}: {
  value: T | null;
  options: Array<PillOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** `${testId}-${option.value}` per pill. */
  testId: string;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            value === o.value
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
