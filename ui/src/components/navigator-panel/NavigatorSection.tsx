import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@src/lib/utils';

interface NavigatorSectionProps {
  /** Stable id — `data-testid="navigator-section-<id>"`. Deliberately NOT a
   *  persistence key: open/closed is derived per mount from the data (below),
   *  so a remembered state would fight the default-open rule. */
  id: string;
  /** Header label. Already translated by the caller. */
  label: string;
  /** Rows still loading. The default-open rule waits for this to clear. */
  isLoading?: boolean;
  /** How many rows `children` will render. Drives the default-open rule ONLY —
   *  it is never displayed. Section headers carry no count badge by design. */
  itemCount: number;
  /** Rendered in place of `children` when settled and empty. */
  emptyState?: ReactNode;
  /** Trailing header control. A SIBLING of the collapse button, never inside
   *  it: nesting an interactive element in a `<button>` is invalid and the click
   *  would also toggle. Stays visible while collapsed. */
  action?: ReactNode;
  children?: ReactNode;
}

/**
 * One collapsible section of a navigator body. Expanded iff non-empty, decided
 * ONCE when data settles — not on first render, where a cold cache reports 0 for
 * every section and would collapse them all permanently. Then it is the user's.
 */
export function NavigatorSection({
  id,
  label,
  isLoading,
  itemCount,
  emptyState,
  action,
  children,
}: NavigatorSectionProps) {
  const [open, setOpen] = useState(false);
  const settled = useRef(false);

  useEffect(() => {
    if (settled.current || isLoading) return;
    settled.current = true;
    setOpen(itemCount > 0);
  }, [isLoading, itemCount]);

  const Chevron = open ? ChevronDown : ChevronRight;
  const isEmpty = !isLoading && itemCount === 0;

  return (
    <div className="flex flex-col">
      <div className="group flex w-full items-center hover:bg-muted/60">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-start"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid={`navigator-section-${id}`}
        >
          {/* Only the COLLAPSED caret points along the reading direction, so only
              it mirrors in RTL; the open one points down. */}
          <Chevron className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground', !open && 'rtl:-scale-x-100')} />
          <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</span>
        </button>
        {action && <div className="flex flex-shrink-0 items-center pe-1">{action}</div>}
      </div>
      {open && <div className="pb-1">{isEmpty ? emptyState : children}</div>}
    </div>
  );
}
