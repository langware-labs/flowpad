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
import { isAppBusy, isAppShowable, type WebAppLifecycle } from '@sdk';

export type AppRuntimeOption = 'dev' | 'served';

interface WebappDisplayToolbarProps {
  /** The app's lifecycle record — the LED says what it says. Null: not known yet. */
  record: WebAppLifecycle | null;
  /** The dev server's own address (`host:port`), shown as text; '' for a served build. */
  address: string;
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

type Led = 'up' | 'degraded' | 'busy' | 'down' | 'checking';

const LED: Record<Led, { color: string; label: React.ReactNode }> = {
  up: { color: 'bg-green-500', label: <Trans>running</Trans> },
  degraded: { color: 'bg-amber-500', label: <Trans>running, with problems</Trans> },
  busy: { color: 'bg-yellow-400 animate-pulse', label: <Trans>coming up…</Trans> },
  down: { color: 'bg-red-500', label: <Trans>not running</Trans> },
  checking: { color: 'bg-yellow-400 animate-pulse', label: <Trans>checking…</Trans> },
};

function ledOf(record: WebAppLifecycle | null): Led {
  if (!record) return 'checking';
  if (isAppShowable(record)) return record.state === 'degraded' ? 'degraded' : 'up';
  return isAppBusy(record) ? 'busy' : 'down';
}

/**
 * PER-TYPE toolbar for a shown web app: a running/health LED, the dev server's
 * address, the runtime switch and refresh. The LED reads the app's lifecycle record
 * (`webapp.lifecycle`) — never a ping of its own.
 */
export function WebappDisplayToolbar({
  record,
  address,
  onRefresh,
  runtime = null,
  runtimes = [],
  onRuntimeChange,
}: WebappDisplayToolbarProps) {
  const { t } = useLingui();
  const led = LED[ledOf(record)];
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
              // Shares the app's segmented look with SessionSurfaceSwitch (see ui/segmented.ts)
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

      {address ? <span className="font-mono text-xs text-muted-foreground">{address}</span> : null}

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
