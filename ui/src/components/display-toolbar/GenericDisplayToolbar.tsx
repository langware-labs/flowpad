import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { AppWindow, ExternalLink } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

interface GenericDisplayToolbarProps {
  /** Resolved BROWSER-external URL for the displayed item (a running webapp's
   *  get-host URL). Renders the "Open externally" action → new browser tab. */
  externalUrl?: string;
  /** In-app promotion for the displayed ENTITY: open it as a Flowpad tab
   *  (dock navigation in THIS browser tab). Renders the "Open in tab" action —
   *  distinct icon + meaning from external. Takes precedence over externalUrl
   *  when both are provided. */
  onOpenInTab?: () => void;
}

/**
 * The GENERIC display toolbar — actions shared by every displayed item,
 * right-aligned. Two mutually-distinct actions:
 *   - entities/files → "Open in tab" (in-app dock tab, AppWindow icon);
 *   - webapps        → "Open externally" (real external URL, new browser tab).
 */
export function GenericDisplayToolbar({ externalUrl, onOpenInTab }: GenericDisplayToolbarProps) {
  const isTab = !!onOpenInTab;
  return (
    <div className="flex items-center gap-1">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              data-testid={isTab ? 'display-open-in-tab' : 'display-open-external'}
              disabled={!isTab && !externalUrl}
              onClick={() => {
                if (isTab) onOpenInTab?.();
                else if (externalUrl) window.open(externalUrl, '_blank');
              }}
            >
              {isTab ? <AppWindow className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
            {isTab ? (
              <p><Trans>Open in a new tab</Trans></p>
            ) : (
              <p><Trans>Open externally</Trans></p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
