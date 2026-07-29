import { Button } from '@src/components/ui/button';
import {
  SEGMENTED_ACTIVE,
  SEGMENTED_BUTTON,
  SEGMENTED_GROUP,
  SEGMENTED_IDLE,
} from '@src/components/ui/segmented';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useWebappHealth, type WebappHealth } from './use-webapp-health';

export type AppRuntimeOption = 'dev' | 'served';

interface WebappDisplayToolbarProps {
  /** The get-host URL the display iframe points at (health is pinged here). */
  host: string;
  /** The dev-server port, shown as text. */
  port: string;
  /** Re-mount / reload the iframe. */
  onRefresh: () => void;
  /** Active runtime, when this app has one. Absent → the legacy port-only view. */
  runtime?: AppRuntimeOption | null;
  /** Runtimes this app currently has. A single one renders no switch. */
  runtimes?: AppRuntimeOption[];
  onRuntimeChange?: (runtime: AppRuntimeOption) => void;
}

const RUNTIME_LABEL: Record<AppRuntimeOption, React.ReactNode> = {
  dev: <Trans>Dev</Trans>,
  served: <Trans>Served</Trans>,
};

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
export function WebappDisplayToolbar({
  host,
  port,
  onRefresh,
  runtime = null,
  runtimes = [],
  onRuntimeChange,
}: WebappDisplayToolbarProps) {
  const { t } = useLingui();
  const health = useWebappHealth(host);
  const led = LED[health];
  // Only a genuine choice earns a control: an app with one runtime shows none.
  const showSwitch = runtimes.length > 1 && !!onRuntimeChange;

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

      {showSwitch && (
        <div className={SEGMENTED_GROUP} role="radiogroup" aria-label={t`App runtime`} data-testid="app-runtime-switch">
          {runtimes.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={runtime === option}
              data-testid={`app-runtime-${option}`}
              onClick={() => onRuntimeChange?.(option)}
              // Shares the app's segmented look with ViewToggle (see ui/segmented.ts)
              // so a themed ring or height change lands here too. `cn` resolves
              // the width conflict: those two hold icons in a fixed w-6 square,
              // these segments hold words.
              className={cn(
                SEGMENTED_BUTTON,
                'w-auto px-1.5 text-[11px] leading-none',
                runtime === option ? SEGMENTED_ACTIVE : SEGMENTED_IDLE,
              )}
            >
              {RUNTIME_LABEL[option]}
            </button>
          ))}
        </div>
      )}

      {/* A served app has no port — its address is this backend's own origin. */}
      {runtime !== 'served' && port ? (
        <span className="font-mono text-xs text-muted-foreground">localhost:{port}</span>
      ) : null}

      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Refresh`}
              title={t`Refresh`}
              className="h-7 w-7"
              onClick={onRefresh}
            >
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
