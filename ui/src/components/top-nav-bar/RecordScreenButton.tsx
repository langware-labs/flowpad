import { forwardRef, useEffect, useState } from 'react';
import { CircleDot, type LucideProps } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { DropdownMenuItem } from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  recordingEntityActionClassName,
  wideClusterButtonAttrs,
} from '@src/components/entity-actions/action-button-styles';
import { cn } from '@src/lib/utils';
import { RecordingReadyDialog } from './RecordingReadyDialog';
import { formatElapsed, startRecording, stopRecording, useScreenRecorder } from './use-screen-recorder';

/** The elapsed time, ticking once a second — its own component so nothing else re-renders with it. */
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
  <CircleDot
    ref={ref}
    className={cn('[&>circle:last-child]:fill-red-500 [&>circle:last-child]:stroke-red-500', className)}
    {...props}
  />
));
RecordIcon.displayName = 'RecordIcon';

/** "Record screen" in the bar's menu: starts a recording. Off while one is running or being saved. */
export function RecordScreenMenuItem() {
  const { t } = useLingui();
  const { phase, busy } = useScreenRecorder();
  return (
    <DropdownMenuItem
      className="gap-2"
      disabled={busy || phase !== 'idle'}
      onSelect={() => void startRecording()}
      title={t`Record screen (video only)`}
      data-testid="top-nav-more-record"
    >
      <RecordIcon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t`Record screen`}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{t`this window`}</span>
    </DropdownMenuItem>
  );
}

/**
 * The recording's presence ON THE BAR: nothing while idle; while recording, a glowing red stop
 * button with the elapsed time (a click stops). The finished recording opens
 * `RecordingReadyDialog` from here, not from the menu, so it outlives the menu closing.
 */
export function RecordingIndicator() {
  const { t } = useLingui();
  const { phase, busy, startedAt, recording } = useScreenRecorder();

  if (phase === 'ready' && recording) return <RecordingReadyDialog recording={recording} />;
  if (phase !== 'recording') return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={stopRecording}
          disabled={busy}
          aria-label={t`Stop recording`}
          data-testid="top-nav-recording-stop"
          data-recording="true"
          {...wideClusterButtonAttrs}
          className={cn(recordingEntityActionClassName, busy && 'animate-none')}
        >
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-current" />
          {busy ? t`Saving…` : startedAt && <Elapsed since={startedAt} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {busy ? t`Saving the recording` : t`Stop recording`}
      </TooltipContent>
    </Tooltip>
  );
}
