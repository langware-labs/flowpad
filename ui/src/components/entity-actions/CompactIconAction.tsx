import type { LucideIcon } from 'lucide-react';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';

/**
 * The compact icon-only action used in entity headers and the nav bar's action
 * cluster: a ghost icon button with its label in a tooltip. The `span` wrapper
 * keeps the tooltip working while the button is disabled.
 */
export function CompactIconAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  testId,
}: {
  icon: LucideIcon;
  /** Tooltip text and `aria-label`. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
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
            className={compactEntityActionClassName}
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            data-testid={testId}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
