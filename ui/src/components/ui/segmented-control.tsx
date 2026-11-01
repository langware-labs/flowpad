import { cn } from '@src/lib/utils';
import { SEGMENTED_ACTIVE, SEGMENTED_DISABLED, SEGMENTED_GROUP, SEGMENTED_IDLE } from './segmented';

const SEGMENT = 'flex h-6 items-center justify-center rounded-sm px-3 text-xs transition-colors';

/** A labelled segmented choice (`role="radiogroup"`), in the shared segmented look. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testId,
  disabled,
  ariaLabel,
  className,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  testId: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(SEGMENTED_GROUP, 'inline-flex h-8', className)} data-testid={testId}>
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={key === value}
          disabled={disabled}
          className={cn(SEGMENT, key === value ? SEGMENTED_ACTIVE : disabled ? SEGMENTED_DISABLED : SEGMENTED_IDLE)}
          onClick={() => key !== value && onChange(key)}
          data-testid={`${testId}-${key}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
