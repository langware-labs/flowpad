import { Button } from '@src/components/ui/button';
import { Trans } from '@lingui/react/macro';
import { Loader2, TriangleAlert, X } from 'lucide-react';
import type { WebappVerdict } from './classify';
import { headlineForCode } from './messages';

interface Props {
  verdict: WebappVerdict;
  fixRunning: boolean;
  onFix: () => void;
  onDismiss: () => void;
}

/**
 * The degraded state: the app works, but something in it is failing.
 *
 * A thin header rather than a takeover, because the app is still usable and
 * replacing it would cost the user more than the warning is worth. It is also
 * dismissible — a known, accepted console error should not nag on every reload.
 */
export function WebappErrorBanner({ verdict, fixRunning, onFix, onDismiss }: Props) {
  return (
    <div
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs"
      data-testid="webapp-error-banner"
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="min-w-0 flex-1 truncate text-foreground">{headlineForCode(verdict.code)}</span>
      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onFix} disabled={fixRunning}>
        {fixRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trans>Fix it</Trans>}
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
        data-testid="webapp-banner-dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
