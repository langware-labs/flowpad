import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useCurrentDeployments } from '@src/hooks/flow-hooks';
import React, { useMemo } from 'react';

interface ServiceStatusLedProps {
  className?: string;
}

/**
 * Deployment observation summary. Start/stop controls were intentionally
 * retired: Artifact no longer carries runtime commands or ports, and cloud
 * inventory is read-only.
 */
export const ServiceStatusLed: React.FC<ServiceStatusLedProps> = ({ className = '' }) => {
  const { t } = useLingui();
  const { data: deployments = [], isLoading } = useCurrentDeployments();

  const summary = useMemo(() => {
    const counts = { current: 0, stale: 0, partial: 0, error: 0 };
    for (const deployment of deployments) counts[deployment.status.sync_state] += 1;
    return counts;
  }, [deployments]);

  if (!isLoading && deployments.length === 0) return null;

  const hasError = summary.error > 0;
  const hasWarning = summary.partial > 0 || summary.stale > 0;
  const color = isLoading
    ? 'bg-yellow-400'
    : hasError
      ? 'bg-red-500'
      : hasWarning
        ? 'bg-amber-400'
        : 'bg-green-500';
  const title = isLoading
    ? t`Loading deployment status…`
    : hasError
      ? t`Some deployments have errors`
      : hasWarning
        ? t`Some deployments are stale or partial`
        : t`All observed deployments are current`;

  return (
    <div className={`flex items-center ${className}`}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`h-2.5 w-2.5 rounded-full ${color} ${isLoading ? 'animate-pulse' : ''}`} aria-label={title} />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs bg-popover text-popover-foreground">
            <p className="text-xs font-medium">{title}</p>
            {!isLoading && (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>
                  {summary.current} current · {summary.stale} stale · {summary.partial} partial · {summary.error} error
                </Trans>
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};
