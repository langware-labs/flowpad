import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@src/lib/utils';

export interface NavigatorSectionProps {
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
  children?: ReactNode;
}

/**
 * One independently collapsible section of a navigator (Zone B) body.
 *
 * Default state is **expanded iff non-empty**, decided ONCE when the data first
 * settles — not on first render. That distinction is the whole rule: on a cold
 * cache every section reports `itemCount === 0` for a frame, so deciding early
 * would collapse all of them permanently and the pane would look empty even
 * once its rows arrived. After that first decision the section belongs to the
 * user: a later emptying never re-collapses it, and a manual toggle is never
 * overridden by arriving data.
 *
 * Generic Zone-B chrome rather than an agent-specific control — the other
 * section-shaped navigator bodies (Triggers' per-type groups, the context
 * panels' `SectionHeader`s) are candidates to adopt it.
 */
export function NavigatorSection({ id, label, isLoading, itemCount, emptyState, children }: NavigatorSectionProps) {
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
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-start hover:bg-muted/60"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`navigator-section-${id}`}
      >
        {/* Only the COLLAPSED caret points along the reading direction, so only
            it mirrors in RTL; the open one points down. */}
        <Chevron className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground', !open && 'rtl:-scale-x-100')} />
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</span>
      </button>
      {open && <div className="pb-1">{isEmpty ? emptyState : children}</div>}
    </div>
  );
}
