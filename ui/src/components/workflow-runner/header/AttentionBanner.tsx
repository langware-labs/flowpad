/**
 * Sticky banner at the top of the runner — only renders when at least one
 * non-dismissed ATTENTION item exists.
 *
 * Click an item with an `anchor.line` to navigate to that step (parent
 * receives `onAnchor` to wire into useStepSelection).
 *
 * Pure render: receives items + dismissed predicate.
 */

import { cn } from '@src/lib/utils';
import { AlertOctagon, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import type { AttentionItem } from '../data/types';

interface AttentionBannerProps {
  items: AttentionItem[];
  isDismissed: (id: string) => boolean;
  onDismiss: (id: string) => void;
  onAnchor?: (line: number) => void;
}

export function AttentionBanner({
  items,
  isDismissed,
  onDismiss,
  onAnchor,
}: AttentionBannerProps) {
  const visible = items.filter((it) => !isDismissed(it.id));
  if (visible.length === 0) return null;
  return (
    <div
      data-testid="attention-banner"
      className={cn(
        'sticky top-0 z-30 border-b border-destructive/30 bg-destructive/5 px-3 py-2',
      )}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-1.5">
        {visible.map((item) => (
          <AttentionRow
            key={item.id}
            item={item}
            onDismiss={() => onDismiss(item.id)}
            onAnchor={onAnchor}
          />
        ))}
      </div>
    </div>
  );
}

function AttentionRow({
  item,
  onDismiss,
  onAnchor,
}: {
  item: AttentionItem;
  onDismiss: () => void;
  onAnchor?: (line: number) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const expandable = !!item.detail && item.detail !== item.headline;
  return (
    <div
      data-testid="attention-row"
      data-attention-id={item.id}
      className="flex items-start gap-2"
    >
      <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1 text-left text-sm font-medium text-destructive hover:underline"
            >
              {open ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {item.headline}
            </button>
          ) : (
            <span className="font-medium text-destructive">{item.headline}</span>
          )}
          {item.reason && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {item.reason}
            </span>
          )}
          {item.anchor?.line && onAnchor && (
            <button
              type="button"
              onClick={() => onAnchor(item.anchor!.line)}
              className="text-[11px] text-destructive underline-offset-2 hover:underline"
            >
              <Trans>jump to L{item.anchor.line}</Trans>
            </button>
          )}
        </div>
        {open && item.detail && (
          <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-sm bg-background/60 p-2 text-[11px] leading-relaxed">
            {item.detail}
          </pre>
        )}
      </div>
      <button
        type="button"
        aria-label={t`Dismiss`}
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
