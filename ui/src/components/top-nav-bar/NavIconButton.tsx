import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { tagAttrs } from '@src/tags/tag-attrs';
import { chromeEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { NavBadge } from '@src/components/ui/nav-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';

/** Wears `chromeEntityActionClassName` — the shared entity-action contract at
 *  its window-chrome size — so the bar reads as one row of controls and the
 *  size lives in the style module rather than in each call site. */
export function NavIconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  mirrorInRtl = false,
  testId,
  tag,
  badge,
  tooltipContent,
  tooltipDelay,
}: {
  icon: LucideIcon;
  label: string;
  tooltipContent?: ReactNode;
  tooltipDelay?: number;
  onClick: () => void;
  disabled?: boolean;
  /** A small count on the glyph's corner; 0 shows nothing. */
  badge?: number;
  /** Mirror the glyph in RTL. For an arrow that means a DIRECTION rather than a
   *  fixed shape: "back" points against the reading flow, so it faces left in
   *  English and right in Hebrew. A house or a folder is the same shape in every
   *  language and must NOT be flipped. */
  mirrorInRtl?: boolean;
  testId: string;
  /** Observable/highlightable tag word (journeys target it). */
  tag?: string;
}) {
  return (
    <Tooltip delayDuration={tooltipDelay}>
      <TooltipTrigger asChild>
        {/* The span keeps the tooltip reachable while the button is disabled —
            a disabled button fires no pointer events of its own. */}
        <span className="relative inline-flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={chromeEntityActionClassName}
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            data-testid={testId}
            {...(tag ? tagAttrs(tag, 'button') : {})}
          >
            <Icon className={cn(mirrorInRtl && 'rtl:-scale-x-100')} />
          </Button>
          {/* The bar's glyph is smaller than the rail's: the chip sits on the corner. */}
          <NavBadge
            count={badge ?? 0}
            className="-end-0.5 -top-0.5 h-3.5 min-w-3.5 bg-brand text-brand-foreground"
            testId={`${testId}-badge`}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltipContent ?? label}
      </TooltipContent>
    </Tooltip>
  );
}
