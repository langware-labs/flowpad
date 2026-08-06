import { useLingui } from '@lingui/react/macro';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useNavigationState } from '@src/hooks/use-navigation-state';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import React from 'react';

/**
 * Back + Refresh buttons for the tab strip's leading region — they lead the
 * bar, left of the project chip (the strip's project dropdown), the way a
 * browser puts its nav controls left of the address bar. Sized to the chip's
 * 7-unit height and `self-center`ed so they ride the strip's `items-end` band
 * without touching its bottom edge.
 */
export const StripNavButtons: React.FC = () => {
  const { t } = useLingui();
  const { goBack, canGoBack } = useNavigationState();

  const btnClass =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground ' +
    'hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring ' +
    'disabled:pointer-events-none disabled:opacity-40';

  return (
    <TooltipProvider delayDuration={400}>
      <div className="ml-1 flex shrink-0 items-center gap-0.5 self-center" data-testid="strip-nav-buttons">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={goBack}
              disabled={!canGoBack}
              aria-label={t`Back`}
              className={btnClass}
              data-testid="strip-nav-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t`Back`}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => window.location.reload()}
              aria-label={t`Refresh`}
              className={btnClass}
              data-testid="strip-nav-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t`Refresh`}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
};

export default StripNavButtons;
