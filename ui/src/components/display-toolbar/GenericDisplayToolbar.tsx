import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { AppWindow, ExternalLink, ImagePlus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useContext as useSdkContext } from '@sdk/react/hooks';
import { hasElectronDisplayCapture } from './capture-region';

interface GenericDisplayToolbarProps {
  /** Resolved BROWSER-external URL for the displayed item (a running webapp's
   *  get-host URL). Renders the "Open externally" action → new browser tab. */
  externalUrl?: string;
  /** In-app promotion for the displayed ENTITY: open it as a Flowpad tab
   *  (dock navigation in THIS browser tab). Renders the "Open in tab" action —
   *  distinct icon + meaning from external. Takes precedence over externalUrl
   *  when both are provided. */
  onOpenInTab?: () => void;
  /** Capture the active display content and open it in the image annotator. */
  onAnnotate?: () => void;
}

/**
 * The GENERIC display toolbar — actions shared by every displayed item,
 * right-aligned. Two mutually-distinct actions:
 *   - entities/files → "Open in tab" (in-app dock tab, AppWindow icon);
 *   - webapps        → "Open externally" (real external URL, new browser tab).
 */
export function GenericDisplayToolbar({ externalUrl, onOpenInTab, onAnnotate }: GenericDisplayToolbarProps) {
  const { t } = useLingui();
  const { isDesktop } = useSdkContext();
  const isTab = !!onOpenInTab;
  const showAnnotate = !!onAnnotate && isDesktop && hasElectronDisplayCapture();
  return (
    <div className="flex items-center gap-1">
      <TooltipProvider delayDuration={300}>
        {showAnnotate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                data-testid="display-annotate-view"
                aria-label={t`Annotate view`}
                title={t`Annotate view`}
                onClick={() => onAnnotate()}
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
              <p><Trans>Annotate view</Trans></p>
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              data-testid={isTab ? 'display-open-in-tab' : 'display-open-external'}
              disabled={!isTab && !externalUrl}
              aria-label={isTab ? t`Open in a new tab` : t`Open externally`}
              title={isTab ? t`Open in a new tab` : t`Open externally`}
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
