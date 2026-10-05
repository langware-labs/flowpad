import { useLingui } from '@lingui/react/macro';
import { CopyButton } from '@src/components/ui/copy-button';
import { cn } from '@src/lib/utils';

/**
 * The header line of every tab chip's hover card: the tab's name plus a button
 * that copies it. Radix keeps a tooltip open while the pointer is over its
 * content, so the button is reachable by moving from the chip into the card.
 */
export function TabTooltipName({ name, className }: { name: string; className?: string }) {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-1.5">
      <p className={cn('min-w-0 text-xs font-semibold text-foreground', className)} data-testid="tab-tooltip-name">
        {name}
      </p>
      <CopyButton
        value={name}
        title={t`Copy name`}
        testId="tab-tooltip-copy-name"
        stopPropagation
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        copiedIconClassName="text-emerald-500"
      />
    </div>
  );
}
