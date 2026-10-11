import type { LucideIcon } from 'lucide-react';
import {
  attentionEntityActionClassName,
  compactEntityActionClassName,
} from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';

/**
 * The compact icon-only action used in entity headers and the nav bar's action
 * cluster: a ghost icon button with its label in a tooltip. The `span` wrapper
 * keeps the tooltip working while the button is disabled. `attention` swaps in
 * the amber glow for an action the user is being asked to take now.
 */
export function CompactIconAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  attention = false,
  iconClassName,
  testId,
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
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
