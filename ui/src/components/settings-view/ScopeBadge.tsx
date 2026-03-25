import { cn } from '@src/lib/utils';
import type { Scope } from './settings-utils';

const SCOPE_STYLES: Record<Scope, string> = {
  default: 'bg-muted text-muted-foreground',
  user: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  project: 'bg-green-500/15 text-green-700 dark:text-green-400',
  local: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

interface ScopeBadgeProps {
  scope: Scope;
  className?: string;
}

export function ScopeBadge({ scope, className }: ScopeBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium',
        SCOPE_STYLES[scope],
        className,
      )}
    >
      {scope}
    </span>
  );
}
