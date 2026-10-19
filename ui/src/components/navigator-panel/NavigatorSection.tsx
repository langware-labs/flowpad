import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@src/lib/utils';

interface NavigatorSectionProps {
  /** Stable id — `data-testid="navigator-section-<id>"`, and (with `scope`) the key its
   *  open/closed choice is remembered under. */
  id: string;
  /** The navigator it belongs to, so two navigators' "docs" sections are remembered apart. */
  scope: string;
  /** Header label. Already translated by the caller. */
  label: string;
  /** Rows still loading — the count waits for it rather than flashing 0. */
  isLoading?: boolean;
  /** How many rows `children` render: shown beside the label, and whether the section is empty. */
  itemCount: number;
  /** The rows are a capped page of more: the count reads "<n>+". */
  truncated?: boolean;
  /** Rendered in place of `children` when settled and empty. Omit it when the
   *  children render their own empty state — they then show either way. */
  emptyState?: ReactNode;
  /** Trailing header control. A SIBLING of the collapse button, never inside
   *  it: nesting an interactive element in a `<button>` is invalid and the click
   *  would also toggle. Stays visible while collapsed. */
  action?: ReactNode;
  children?: ReactNode;
}

function storageKey(scope: string, id: string): string {
  return `navigator:${scope}:section:${id}:open`;
}

/** The section's remembered choice — closed unless this browser opened it before. Storage can be
 *  missing or throw (a private window, blocked site data); then it is simply closed. */
function readOpen(scope: string, id: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(scope, id)) === '1';
  } catch {
    return false;
  }
}

function writeOpen(scope: string, id: string, open: boolean): void {
  try {
    window.localStorage.setItem(storageKey(scope, id), open ? '1' : '0');
  } catch {
    /* not remembered — the section still toggles */
  }
}

/**
 * One collapsible section of a navigator body. Closed by default with its item count beside the
 * label; a section the person opens stays open the next time the navigator is shown.
 */
export function NavigatorSection({
  id,
  scope,
  label,
  isLoading,
  itemCount,
  truncated,
  emptyState,
  action,
  children,
}: NavigatorSectionProps) {
  const [open, setOpen] = useState(() => readOpen(scope, id));

  const toggle = () =>
    setOpen((was) => {
      writeOpen(scope, id, !was);
      return !was;
    });

  const Chevron = open ? ChevronDown : ChevronRight;
  const isEmpty = !isLoading && itemCount === 0;

  return (
    <div className="flex flex-col">
      <div className="group flex w-full items-center hover:bg-muted/60">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-start"
          onClick={toggle}
          aria-expanded={open}
          data-testid={`navigator-section-${id}`}
        >
          {/* Only the COLLAPSED caret points along the reading direction, so only
              it mirrors in RTL; the open one points down. */}
          <Chevron className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground', !open && 'rtl:-scale-x-100')} />
          <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</span>
          {!isLoading && (
            <span
              className="ms-auto flex-shrink-0 text-[11px] font-semibold text-foreground"
              data-testid={`navigator-section-${id}-count`}
            >
              {truncated ? `${itemCount}+` : itemCount}
            </span>
          )}
        </button>
        {action && <div className="flex flex-shrink-0 items-center pe-1">{action}</div>}
      </div>
      {open && <div className="pb-1">{isEmpty ? (emptyState ?? children) : children}</div>}
    </div>
  );
}
