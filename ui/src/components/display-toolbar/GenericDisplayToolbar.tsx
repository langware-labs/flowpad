import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { ExternalLink } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

interface GenericDisplayToolbarProps {
  /** Resolved external URL for the currently-displayed item, or undefined when
   *  nothing openable is shown (button disabled). Webapp → the get-host URL;
   *  asset/file → its standalone dock URL. */
  externalUrl?: string;
}

/**
 * The GENERIC display toolbar — actions shared by every displayed item,
 * right-aligned. Type-agnostic: it only knows the resolved `externalUrl`.
 * Built to grow; for now the single action is "Open externally".
 */
export function GenericDisplayToolbar({ externalUrl }: GenericDisplayToolbarProps) {
  return (
    <div className="flex items-center gap-1">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!externalUrl}
              onClick={() => externalUrl && window.open(externalUrl, '_blank')}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
            <p><Trans>Open externally</Trans></p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
