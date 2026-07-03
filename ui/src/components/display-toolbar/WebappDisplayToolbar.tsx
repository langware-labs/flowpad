import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useWebappHealth, type WebappHealth } from './use-webapp-health';

interface WebappDisplayToolbarProps {
  /** The get-host URL the display iframe points at (health is pinged here). */
  host: string;
  /** The dev-server port, shown as text. */
  port: string;
  /** Re-mount / reload the iframe. */
  onRefresh: () => void;
}

const LED: Record<WebappHealth, { color: string; label: React.ReactNode }> = {
  up: { color: 'bg-green-500', label: <Trans>running</Trans> },
  down: { color: 'bg-red-500', label: <Trans>not reachable</Trans> },
  checking: { color: 'bg-yellow-400 animate-pulse', label: <Trans>checking…</Trans> },
};

/**
 * PER-TYPE toolbar for a shown web app — the artifact-independent status the
 * hub's web viewer surfaces: the port and a running/health LED, plus refresh.
 * Health comes from pinging the get-host URL (see useWebappHealth), so it works
 * for the `flow show webapp --port` path where there's no WEBAPP artifact.
 */
export function WebappDisplayToolbar({ host, port, onRefresh }: WebappDisplayToolbarProps) {
  const { t } = useLingui();
  const health = useWebappHealth(host);
  const led = LED[health];

  return (
    <div className="flex items-center gap-2">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`h-2.5 w-2.5 rounded-full ${led.color} cursor-default`}
              aria-label={t`Web app status`}
            />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
            <p className="text-xs">{led.label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <span className="font-mono text-xs text-muted-foreground">localhost:{port}</span>

      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-popover text-popover-foreground">
            <p><Trans>Refresh</Trans></p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
