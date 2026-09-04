import { SquareTerminal } from 'lucide-react';
import * as React from 'react';

import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
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
 * Composed through `IconWithBadge` — the repo's base-plus-corner-badge composer,
 * whose own docstring notes that the `*RestoreIcon` components hand-roll this
 * markup and should migrate onto it. A fourth hand-rolled copy is how the corner
 * badge ends up sitting in four slightly different places.
 *
 * The vendor half stays `providerMetaFor`, the one table the strip reads, so a
 * harness added there is drawn here without a second mapping. Only the BADGE is
 * this table's own: a tab strip chip is already known to be a terminal, and
 * badging it there would be noise on every row.
 */
export function HarnessMark({ worker, className }: { worker: string; className?: string }) {
  const { Icon, iconClassName } = providerMetaFor(worker);
  return (
    <IconWithBadge
      Base={Icon}
      Badge={SquareTerminal}
      className={className ?? 'h-4 w-4 shrink-0'}
      baseClassName={iconClassName}
      badgeClassName="text-muted-foreground"
      aria-label={`${worker} CLI login`}
    />
  );
}
