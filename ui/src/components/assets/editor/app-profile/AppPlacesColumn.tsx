import { Trans, useLingui } from '@lingui/react/macro';
import { Laptop, Loader2 } from 'lucide-react';

import { Button } from '@src/components/ui/button';

import type { AppRunState } from './use-app-run-state';

interface AppPlacesColumnProps {
  run: AppRunState;
  /** The audience and address the page is served at, e.g. "Admins · /spora-admin/". */
  served: string | null;
  onRestart: () => void;
  /** Turns off "Only this port" for the process whose port is held, then restarts. */
  onAnyFreePort: (process: string) => void;
}

/**
 * Where the app runs: this computer, with each process's live port and state. A process that cannot
 * start (its required port held by another program) says so on this row, with the fix one click away.
 */
export function AppPlacesColumn({ run, served, onRestart, onAnyFreePort }: AppPlacesColumnProps) {
  const { t } = useLingui();
  const rows = run.rows ?? [];
  const { conflict, running } = run;
  const state = conflict ? t`Failed` : running ? t`Running` : run.rows === null ? '' : t`Stopped`;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="app-deployments" data-testid="app-places">
      <h2 id="app-deployments" className="text-sm font-semibold">
        <Trans>Deployments</Trans>
      </h2>
      <ul className="flex flex-col divide-y rounded-md border">
        <li data-testid="app-place-local">
          <div className="flex w-full items-center gap-2 px-3 py-2">
            <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">
              <Trans>Development · local</Trans>
            </span>
            <span
              className={conflict ? 'shrink-0 text-xs text-destructive' : 'shrink-0 text-xs text-muted-foreground'}
              data-testid="app-place-state"
            >
              {run.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state}
            </span>
          </div>
          {conflict ? (
            <div className="space-y-2 px-3 pb-3">
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="app-place-error"
              >
                {conflict.process === 'page' ? conflict.note : `${conflict.process}: ${conflict.note}`}
              </div>
              <div className="flex gap-2">
                {conflict.required && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={run.busy}
                    onClick={() => onAnyFreePort(conflict.process)}
                    data-testid="app-any-free-port"
                  >
                    <Trans>Use any free port</Trans>
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8" disabled={run.busy} onClick={onRestart}>
                  <Trans>Retry</Trans>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1 px-3 pb-3 ps-9 text-xs text-muted-foreground" data-testid="app-place-processes">
              {run.changes.length > 0 && (
                <div className="text-amber-700 dark:text-amber-400">
                  <Trans>Running the old definition — Restart to apply</Trans>
                </div>
              )}
              {rows.map((row) => (
                <div key={row.process}>
                  {row.process === 'page' ? (served ?? t`Page`) : row.process}
                  {' → '}
                  {row.port ? t`port ${row.port}` : row.state === 'stopped' ? t`not running` : row.note}
                </div>
              ))}
              {run.rows !== null && !running && (
                <Button size="sm" variant="outline" className="mt-1 h-8" disabled={run.busy} onClick={onRestart}>
                  <Trans>Start</Trans>
                </Button>
              )}
            </div>
          )}
        </li>
      </ul>
    </section>
  );
}
