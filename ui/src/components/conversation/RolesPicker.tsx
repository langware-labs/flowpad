import { ChevronDown } from 'lucide-react';

import { cn } from '@src/lib/utils';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';

/**
 * Pick one or more roles: a button naming the chosen roles ("Reader + Runner") that opens a checklist. Replaces a
 * native `<select multiple>`, which browsers draw as a scrolling list box. Keeps at least one role chosen.
 */
export function RolesPicker({
  roles,
  value,
  onChange,
  disabled,
  ariaLabel,
  testId,
  className,
}: {
  roles: string[];
  value: string[];
  onChange: (roles: string[]) => void;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
  className?: string;
}) {
  const toggle = (role: string, on: boolean) => {
    const next = on ? [...value, role] : value.filter((r) => r !== role);
    if (next.length > 0) onChange(roles.filter((r) => next.includes(r)));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2 capitalize text-foreground outline-none transition-colors hover:border-primary/60 focus:border-primary disabled:opacity-40',
            className,
          )}
        >
          <span className="truncate">{value.join(' + ') || '—'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[8rem]">
        {roles.map((r) => (
          <DropdownMenuCheckboxItem
            key={r}
            checked={value.includes(r)}
            onCheckedChange={(on) => toggle(r, on === true)}
            onSelect={(e) => e.preventDefault()}
            className="text-xs capitalize"
            data-testid={testId ? `${testId}-${r}` : undefined}
          >
            {r}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
