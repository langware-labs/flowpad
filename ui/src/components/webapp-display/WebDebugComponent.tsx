import { Button } from '@src/components/ui/button';
import { Trans } from '@lingui/react/macro';
import { Loader2, TriangleAlert, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { WebappVerdict } from './classify';
import { headlineForCode } from './messages';

interface Props {
  verdict: WebappVerdict;
  fixRunning: boolean;
  toolCount: number;
  onFix: () => void;
  onRetry: () => void;
}

/**
 * What the display shows instead of the app when there is nothing to look at.
 *
 * The failure this replaced was a bare broken-image icon: the iframe pointed at
 * a dead port, and because a cross-origin navigation failure still fires
 * `onload`, nothing in the UI ever learned it had failed. So the first duty here
 * is simply to SAY something — in the user's terms, about their app, not about
 * our probe.
 *
 * The technical evidence is present but folded away. The person reading this
 * wants to know their app is down and to press one button; the stack trace is
 * for the agent that gets sent to fix it.
 */
export function WebDebugComponent({ verdict, fixRunning, toolCount, onFix, onRetry }: Props) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-4 overflow-auto bg-muted/30 p-6"
      data-testid="webapp-debug-panel"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <TriangleAlert className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground" data-testid="webapp-error-headline">
          {headlineForCode(verdict.code)}
        </p>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onFix} disabled={fixRunning} data-testid="webapp-fix-button">
            {fixRunning ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                <Trans>Fixing…</Trans>
                {toolCount > 0 && <span className="ml-1 opacity-70">{toolCount}</span>}
              </>
            ) : (
              <>
                <Wrench className="mr-1.5 h-3.5 w-3.5" />
                <Trans>Fix it</Trans>
              </>
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRetry} disabled={fixRunning}>
            <Trans>Try again</Trans>
          </Button>
        </div>

        {verdict.detail.length > 0 && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowDetail((v) => !v)}
            data-testid="webapp-detail-toggle"
          >
            {showDetail ? <Trans>Hide details</Trans> : <Trans>Details</Trans>}
          </button>
        )}
        {showDetail && verdict.detail.length > 0 && (
          <pre
            className="max-h-40 w-full overflow-auto rounded bg-muted p-2 text-left text-[11px] text-muted-foreground"
            data-testid="webapp-detail-body"
          >
            {verdict.detail.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
