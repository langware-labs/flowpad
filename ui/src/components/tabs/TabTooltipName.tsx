import { createContext, useContext } from 'react';
import { useLingui } from '@lingui/react/macro';
import { CopyButton } from '@src/components/ui/copy-button';
import { cn } from '@src/lib/utils';

/**
 * Set around a tab tip's body. The strip draws the tip's header itself — the
 * tab's full title — so a body rendered under it must not name the tab again.
 * The same cards keep their name line everywhere else (a breadcrumb's card).
 * A card's own name for the thing (an entity's title under a renamed tab) is
 * dropped with it: a tab tip carries one name, the tab's.
 */
export const TabTipBodyContext = createContext(false);
export const useInTabTip = () => useContext(TabTipBodyContext);

/**
 * The name line of a hover card: the name plus a button that copies it. Radix
 * keeps a tooltip open while the pointer is over its content, so the button is
 * reachable by moving from the chip into the card. Renders nothing inside a tab
 * tip's body, where the strip's header already is this line.
 */
export function TabTooltipName({ name, className }: { name: string; className?: string }) {
  const { t } = useLingui();
  if (useInTabTip()) return null;
  return (
    <div className="flex items-center gap-1.5">
      <p className={cn('min-w-0 text-sm font-semibold text-foreground', className)} data-testid="tab-tooltip-name">
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
