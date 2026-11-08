import { forwardRef, useEffect, useState } from 'react';
import { CircleDot, type LucideIcon, type LucideProps } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { chromeEntityActionClassName, wideClusterButtonAttrs } from '@src/components/entity-actions/action-button-styles';
import { cn } from '@src/lib/utils';
import { NavIconButton } from './NavIconButton';
import { RecordingReadyDialog } from './RecordingReadyDialog';
import { formatElapsed, startRecording, stopRecording, useScreenRecorder } from './use-screen-recorder';

/** The elapsed time, ticking once a second — its own component so the idle button has no timer. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatElapsed(now - since)}</>;
}

/** The record glyph: a ring with a red dot. */
const RecordIcon = forwardRef<SVGSVGElement, LucideProps>(({ className, ...props }, ref) => (
  <CircleDot ref={ref} className={cn('[&>circle:last-child]:fill-red-500 [&>circle:last-child]:stroke-red-500', className)} {...props} />
));
RecordIcon.displayName = 'RecordIcon';

/**
 * The bar's Record button, first in the action cluster. Idle it is a record glyph (ring + dot); while
 * recording it is a glowing red pulsing square with the elapsed time (a wide cluster button), and
 * clicking it stops. The finished recording opens `RecordingReadyDialog`.
 */
export function RecordScreenButton() {
  const { t } = useLingui();
  const { phase, busy, startedAt, recording } = useScreenRecorder();

  if (phase === 'recording') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={stopRecording}
            disabled={busy}
            aria-label={t`Stop recording`}
            data-testid="top-nav-record-screen"
            data-recording="true"
            {...wideClusterButtonAttrs}
            className={cn(chromeEntityActionClassName, 'relative w-auto gap-1.5 px-2 text-xs font-medium tabular-nums text-red-500 hover:text-red-500')}
          >
            {!busy && <span aria-hidden className="pointer-events-none absolute inset-0 animate-pulse rounded-md bg-red-500/10 shadow-[0_0_10px_2px_rgba(239,68,68,0.55)] ring-1 ring-red-500/60" />}
            <span className={cn('inline-block h-2.5 w-2.5 rounded-sm bg-red-500', !busy && 'animate-pulse')} />
            {busy ? t`Saving…` : startedAt && <Elapsed since={startedAt} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {busy ? t`Saving the recording` : t`Stop recording`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <NavIconButton
        icon={RecordIcon as LucideIcon}
        label={t`Record screen`}
        tooltipContent={t`Record screen (video only)`}
        onClick={() => void startRecording()}
        disabled={busy}
        testId="top-nav-record-screen"
      />
      {phase === 'ready' && recording && <RecordingReadyDialog recording={recording} />}
    </>
  );
}
