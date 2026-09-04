import { SquareTerminal } from 'lucide-react';
import * as React from 'react';

import { cn } from '@src/lib/utils';
import { providerMetaFor } from '@src/tabs/provider-meta';

/**
 * A harness login's glyph: the vendor's own mark, badged as a terminal.
 *
 * The vendor mark alone is the same glyph the terminal strip uses for a Claude
 * or Codex TAB, so in a table that also lists OAuth grants and API keys it said
 * only "Claude" — not "a CLI session on this machine, which only that CLI can
 * spend". The badge is the kind, the mark is the vendor, and a row needs both:
 * the Sign-in column can say "Anthropic account · Max", and the icon still has
 * to distinguish that from an Anthropic API key two rows down.
 *
 * Composed here rather than in `PROVIDER_META` because the badge means
 * something only in this table — a tab strip chip is already known to be a
 * terminal, and badging it there would be noise on every row.
 */
export function HarnessMark({ worker, className }: { worker: string; className?: string }) {
  const { Icon, iconClassName } = providerMetaFor(worker);
  return (
    <span className={cn('relative inline-flex h-4 w-4 shrink-0', className)}>
      <Icon className={cn('h-4 w-4', iconClassName)} />
      {/* Anchored outside the mark's box and given the row's own background so
          the badge reads as ON the icon rather than as part of the logo. */}
      <SquareTerminal
        className="absolute -bottom-1 -end-1 h-2.5 w-2.5 rounded-[2px] bg-background text-muted-foreground"
        aria-hidden="true"
      />
    </span>
  );
}
