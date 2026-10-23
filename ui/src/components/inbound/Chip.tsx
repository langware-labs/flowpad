import type { ReactNode } from 'react';
import { cn } from '@src/lib/utils';

/** A small pill button that is on or off — the Inbound screen's filters and pickers. */
export function Chip({
  active,
  onClick,
  testId,
  disabled,
  className,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  testId: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      {children}
    </button>
  );
}
