/**
 * What an automation is, in one glance: IF <condition> → THEN <action>.
 * Replaces a paragraph of intro text at the top of the list.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowRight } from 'lucide-react';

export function IfThenGraphic() {
  const { t } = useLingui();
  return (
    <div
      className="flex items-center gap-2 text-sm"
      data-testid="automations-if-then"
      aria-label={t`If a condition, then an action`}
    >
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          <Trans>If</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>condition</Trans>
        </span>
      </span>
      <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          <Trans>Then</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>action</Trans>
        </span>
      </span>
    </div>
  );
}
