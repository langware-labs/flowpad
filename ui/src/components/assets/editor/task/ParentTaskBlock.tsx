/**
 * ParentTaskBlock — read-only summary of a member task's group parent, rendered
 * ABOVE the child's own section so parent context is visible without repeating
 * it in the child's fields. The parent is the single source of truth for
 * title / priority / dates / description; the child owns only its status (and
 * its own attachments), rendered by the caller below this block.
 */

import { Task } from '@sdk';
import { cn } from '@src/lib/utils';
import { ExternalLink } from 'lucide-react';
import { type ReactNode } from 'react';
import { PRIORITY_CONFIG, statusLabel } from '@src/components/task-bar/constants';

interface ParentTaskBlockProps {
  parent: Task;
  /** When provided, the label becomes a button that opens the parent's full view. */
  onOpenParent?: () => void;
  /** Compact spacing/typography for the sliding detail panel. */
  compact?: boolean;
  className?: string;
  /** Rendered INSIDE the card, flush to its bottom edge below the description
   *  (e.g. the parent's read-only Files & Folders) so it sits within the
   *  parent's border. Falsy children render nothing (no empty divider). */
  children?: ReactNode;
}

function toDateLabel(v?: Date | string | null): string {
  if (!v) return '';
  const d = typeof v === 'string' ? new Date(v) : v;
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ParentTaskBlock({ parent, onOpenParent, compact, className, children }: ParentTaskBlockProps) {
  const priority = parent.priority;
  const due = toDateLabel(parent.due_at);
  const start = toDateLabel(parent.start_date);
  const description = (parent.descriptionPlainText || '').trim();

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border bg-muted/30',
        compact ? 'gap-1.5 p-3' : 'gap-2 p-4',
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpenParent}
        disabled={!onOpenParent}
        className="flex items-center gap-1.5 self-start text-[10px] font-medium uppercase tracking-wide text-muted-foreground enabled:hover:text-foreground"
      >
        Parent task
        {onOpenParent && <ExternalLink className="h-3 w-3" />}
      </button>

      <h2 className={cn('font-semibold leading-tight', compact ? 'text-sm' : 'text-lg')}>
        {parent.title || 'Untitled task'}
      </h2>

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="rounded-full border px-2 py-0.5">{statusLabel(parent.status)}</span>
        {priority && (
          <span className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 capitalize">
            <span className={cn('h-2 w-2 rounded-full', PRIORITY_CONFIG[priority]?.color)} />
            {priority}
          </span>
        )}
        {due && (
          <span className="rounded-full border px-2 py-0.5">
            <span className="text-[10px] uppercase tracking-wide">Due </span>
            {due}
          </span>
        )}
        {start && (
          <span className="rounded-full border px-2 py-0.5">
            <span className="text-[10px] uppercase tracking-wide">Start </span>
            {start}
          </span>
        )}
      </div>

      {description && (
        <p
          className={cn(
            'whitespace-pre-wrap text-foreground/80',
            compact ? 'max-h-32 overflow-y-auto text-sm' : 'text-sm',
          )}
        >
          {description}
        </p>
      )}

      {children && <div className={cn('mt-1 border-t', compact ? '-mx-3 -mb-3' : '-mx-4 -mb-4')}>{children}</div>}
    </div>
  );
}
