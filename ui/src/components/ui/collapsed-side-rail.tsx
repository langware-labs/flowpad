import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Shared collapsed side-window rail. The thin vertical strip shown in place of a
 * docked drawer when it's collapsed. Right-anchored (`border-l`), matches the
 * drawer width vocabulary. The host passes whatever rail controls it needs as
 * `children` — `SideRailButton` for the common icon-button case, or a custom
 * node (e.g. a popover trigger). Consumed by the markdown side window and the
 * graph-context automation rail.
 */
export function CollapsedSideRail({
  children,
  className,
  'data-testid': dataTestId,
}: {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      className={cn(
        'flex w-9 shrink-0 flex-col items-center gap-0.5 border-l bg-background py-1',
        className,
      )}
      data-testid={dataTestId}
    >
      <TooltipProvider delayDuration={400}>{children}</TooltipProvider>
    </div>
  );
}

/** One icon button + left-tooltip in a {@link CollapsedSideRail}. */
export function SideRailButton({
  icon: Icon,
  label,
  onClick,
  testId,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  testId?: string;
  /** Highlight as the/an open window (workspace rail). */
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          data-testid={testId}
          data-active={active ? 'true' : 'false'}
          aria-label={label}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded hover:bg-muted hover:text-foreground',
            active ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
