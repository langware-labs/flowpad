import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  attentionEntityActionClassName,
  compactEntityActionClassName,
} from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';

/**
 * The compact icon-only action used in entity headers and the nav bar's action
 * cluster: a ghost icon button with its label in a tooltip. The `span` wrapper
 * keeps the tooltip working while the button is disabled. `attention` swaps in
 * the amber glow for an action the user is being asked to take now.
 * `hoverContent` swaps the label tooltip for a hover card with richer content.
 */
export function CompactIconAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  attention = false,
  iconClassName,
  testId,
  hoverContent,
}: {
  icon: LucideIcon;
  /** Tooltip text and `aria-label`. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Glow: the action is being asked for right now. Also sets `data-attention`. */
  attention?: boolean;
  /** Extra classes on the icon (a spinner's `animate-spin`). */
  iconClassName?: string;
  testId: string;
  /** Hover card body shown instead of the label tooltip (the label stays the `aria-label`). */
  hoverContent?: ReactNode;
}) {
  const trigger = (
    <span className="inline-flex shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={attention ? attentionEntityActionClassName : compactEntityActionClassName}
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        data-testid={testId}
        data-attention={attention ? 'true' : 'false'}
      >
        <Icon className={iconClassName ? `h-3.5 w-3.5 ${iconClassName}` : 'h-3.5 w-3.5'} />
      </Button>
    </span>
  );
  if (hoverContent) {
    return (
      <HoverCard openDelay={150} closeDelay={150}>
        <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
        <HoverCardContent side="bottom" align="start" className="w-96 p-0 text-xs">
          {hoverContent}
        </HoverCardContent>
      </HoverCard>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
