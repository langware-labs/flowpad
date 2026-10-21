import { useMemo, useState } from 'react';
import { useWatch } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessProgressInfo } from '@src/hooks/use-process-progress-info';
import type { SetupFix } from './use-setup-fix';

/** A failed setup: Fix it is the default, Cancel beside it, Try again only a small link. */
export function SetupFailureActions({
  fix,
  busy,
  onCancel,
}: {
  /** Owned by the screen, not this block: the fixer's own proof run flips the load to running, and that
   *  must not unmount — and forget — the fix that is under way. */
  fix: SetupFix;
  busy: boolean;
  /** Leave the failure as it is (close the dialog). Without one, Cancel only stops a running fix. */
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [why, setWhy] = useState(false);
  const { state, process } = fix;
  const running = state.phase === 'running';
  const openProcess = () => process && navigation.openDock(DockPointer.forProcessRuns({ run: process.id }));
  const cancel = running ? fix.cancel : onCancel;
  // The one-liner rides the process stream, which reaches this page only while it is watched.
  const processTypeId = useMemo(() => process?.typeId ?? null, [process]);
  useWatch(processTypeId, running);
  // The one-liner: what the fixer last said, else what it is doing now.
  const progress = useProcessProgressInfo(running ? process : null, running);
  return (
    <div className="flex flex-col gap-3" data-testid="setup-failure-actions">
      {state.phase !== 'idle' && (
        <div className="flex flex-col gap-1 text-sm" data-testid="setup-fix-status">
          <p role="status" className={state.phase === 'not_fixed' ? 'rounded border border-destructive p-2' : ''}>
            {running ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="truncate" data-testid="setup-fix-line">
                  {progress.statusMessage || progress.activityLabel || <Trans>Fixing the setup…</Trans>}
                </span>
                {progress.elapsedTime && <span className="shrink-0 text-muted-foreground">{progress.elapsedTime}</span>}
              </span>
            ) : state.phase === 'fixed' ? (
              state.summary
            ) : (
              state.userAction
            )}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setWhy(!why)}
              aria-expanded={why}
              aria-label={t`Details`}
              data-testid="setup-fix-expand"
            >
              {why ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
            {process && (
              <button type="button" className="text-muted-foreground hover:underline" onClick={openProcess}>
                <Trans>Open process</Trans>
              </button>
            )}
          </div>
          {why && (
            <p className="whitespace-pre-wrap text-muted-foreground" data-testid="setup-fix-why">
              {[fix.failure, state.phase !== 'running' ? state.summary : ''].filter(Boolean).join('\n\n')}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={busy || running} onClick={() => void fix.start()}>
          <Trans>Fix it</Trans>
        </Button>
        {cancel && (
          <Button variant="outline" onClick={cancel}>
            <Trans>Cancel</Trans>
          </Button>
        )}
        <Button
          variant="link"
          size="sm"
          className="text-muted-foreground"
          disabled={busy || running}
          onClick={fix.retry}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    </div>
  );
}
