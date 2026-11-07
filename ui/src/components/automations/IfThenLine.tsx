/**
 * An automation as one line: IF <when> → THEN <what> — the chips the Automations page header uses.
 * ``more`` sits inside the IF chip (a package's "+N" conditions).
 */
import type { ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { ArrowRight } from 'lucide-react';

const CHIP = 'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1';
const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-primary';

export function IfThenLine({ when, then, more }: { when: string; then: string; more?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className={CHIP}>
        <span className={LABEL}>
          <Trans>If</Trans>
        </span>
        <span className="truncate">{when}</span>
        {more}
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className={CHIP}>
        <span className={LABEL}>
          <Trans>Then</Trans>
        </span>
        <span className="truncate">{then}</span>
      </span>
    </div>
  );
}
