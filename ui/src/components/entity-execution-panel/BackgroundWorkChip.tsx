import type { AgenticProcess } from '@sdk';
import { Hourglass } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { notify } from '@src/notifications/notify';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';

/**
 * Composer pill for a session whose agent left work running in the background (a dev server, a
 * watcher). The agent has answered and the chat takes messages as usual, so there is no turn to
 * stop — but its process is still alive, and until now nothing in the UI could end it. Hidden
 * unless the backend reports `background_work`. Clicking explains what it is and offers the stop,
 * behind a second click because stopping ends the work itself.
 */
export function BackgroundWorkChip({ process }: { process: AgenticProcess | null }) {
  const { t } = useLingui();
  const [stopping, setStopping] = useState(false);
  if (!process || !process.background_work) return null;

  const stop = async () => {
    setStopping(true);
    try {
      await process.stopBackground();
    } catch (err) {
      console.error('[BackgroundWorkChip] stop failed', err);
      notify.error({ title: t`Could not stop`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setStopping(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="background-work-chip"
          title={t`Background tasks are running`}
          className={[
            'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5',
            'text-[11px] leading-none text-muted-foreground',
            'bg-muted/40 transition-colors hover:bg-muted hover:text-foreground',
          ].join(' ')}
        >
          <Hourglass className="h-3 w-3 animate-pulse" />
          <span>{t`Background tasks`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 space-y-2 p-3" data-testid="background-work-popover">
        <p className="text-xs text-muted-foreground">
          {t`The agent left work running in the background. You can keep chatting. Stopping it ends that work.`}
        </p>
        <Button
          variant="destructive"
          size="sm"
          disabled={stopping}
          onClick={() => void stop()}
          data-testid="background-work-stop"
        >
          {t`Stop background work`}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
