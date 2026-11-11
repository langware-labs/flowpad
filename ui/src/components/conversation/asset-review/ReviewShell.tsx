import type { ComponentType, ReactNode } from 'react';
import { useState } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { cn } from '@src/lib/utils';

type Icon = ComponentType<{ className?: string }>;

/** One row of the review's list. */
export interface ReviewRow {
  id: string;
  name: string;
  Icon: Icon;
  /** Nesting under its parent row (0 = top level). */
  depth?: number;
  /** A dot after the name -- "installed" on the receiving side. */
  marked?: string | null;
  testId?: string;
}

/** The selected item, as its header shows it. */
export interface ReviewSelected {
  Icon: Icon;
  name: string;
  typeWord: string;
  description?: string | null;
  /** Where it comes from ("Source: …"). */
  source?: ReactNode;
}

interface ReviewShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  /** The buttons on top: Install … on the receiving side, Share / Leave out on the sending side. */
  actions: ReactNode;
  rows: ReviewRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  selected: ReviewSelected;
  /** The selected item's content: its viewer. */
  children: ReactNode;
  /** Rendered inside the dialog, above everything (subscriptions, pickers). */
  extra?: ReactNode;
  testId?: string;
}

/**
 * The message review: ONE frame for reviewing what a message carries -- before installing what was received
 * (``AssetReviewDialog``) and before sharing what is about to be sent (``ContentReviewDialog``). Same list,
 * same header, same viewer slot; only the title and the actions differ.
 */
export function ReviewShell({
  open,
  onClose,
  title,
  description,
  actions,
  rows,
  selectedId,
  onSelect,
  selected,
  children,
  extra,
  testId = 'asset-review-dialog',
}: ReviewShellProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const SelectedIcon = selected.Icon;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          'sm:max-w-3xl',
          fullscreen &&
            'h-screen max-h-screen w-screen max-w-none sm:max-w-none sm:rounded-none [&_[data-testid=staged-review]]:h-[calc(100vh-15rem)]',
        )}
        data-testid={testId}
      >
        <button
          type="button"
          onClick={() => setFullscreen((f) => !f)}
          title={fullscreen ? t`Exit full screen` : t`Full screen`}
          aria-label={fullscreen ? t`Exit full screen` : t`Full screen`}
          data-testid="asset-review-fullscreen"
          className="absolute right-11 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        {extra}
        <DialogHeader>
          <DialogTitle className="font-bold">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">{actions}</div>

        {/* Two panes: the list | the selected item's own viewer. */}
        <div className="flex min-h-0 gap-3 border-t border-border pt-3">
          {rows.length > 1 && (
            <div
              className={cn(
                'w-52 shrink-0 overflow-y-auto border-e border-border pe-2',
                fullscreen ? 'max-h-[calc(100vh-15rem)]' : 'max-h-[55vh]',
              )}
            >
              {rows.map((row) => {
                const RowIcon = row.Icon;
                const isSel = row.id === selectedId;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => onSelect(row.id)}
                    title={row.name}
                    data-testid={row.testId ?? `asset-review-row-${row.id}`}
                    style={row.depth ? { paddingLeft: `${row.depth * 0.875 + 0.375}rem` } : undefined}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-start text-[12px] transition-colors',
                      isSel ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    {!!row.depth && <span className="shrink-0 text-muted-foreground/50">└</span>}
                    <RowIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    {row.marked && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        title={row.marked}
                        aria-label={row.marked}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <SelectedIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate font-semibold" data-testid="asset-review-selected-name">
                  {selected.name}
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                  {selected.typeWord}
                </span>
              </div>
              {selected.description && <p className="text-[12px] text-muted-foreground">{selected.description}</p>}
              {selected.source}
            </div>
            {children}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Source: …" under the selected item's name. */
export function ReviewSource({ Icon, label, detail }: { Icon: Icon; label: string; detail?: string | null }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="asset-review-source">
      <Icon className="h-3 w-3 shrink-0" />
      <span>
        <Trans>Source:</Trans> {label}
      </span>
      {detail && <span className="truncate font-mono text-[10px]">{detail}</span>}
    </div>
  );
}
