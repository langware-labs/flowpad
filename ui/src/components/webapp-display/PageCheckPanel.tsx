import { Trans } from '@lingui/react/macro';
import { Check, Circle, Loader2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import type { PageCheck } from './usePageCheck';

export type Mark = 'done' | 'failed' | 'running' | 'next';

export function Step({ mark, title, detail }: { mark: Mark; title: ReactNode; detail?: ReactNode }) {
  const icon =
    mark === 'done' ? (
      <Check className="size-4 text-emerald-400" />
    ) : mark === 'failed' ? (
      <X className="size-4 text-destructive" />
    ) : mark === 'running' ? (
      <Loader2 className="size-4 animate-spin text-amber-500" />
    ) : (
      <Circle className="size-4 text-muted-foreground" />
    );
  return (
    <li className="flex gap-3 px-3 py-2" data-mark={mark}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {detail && <div className="break-words text-xs text-muted-foreground">{detail}</div>}
      </div>
    </li>
  );
}

/** What the page threw, one line per error, with what each one is known as. */
function Errors({ page }: { page: PageCheck }) {
  const toRecover = page.verdict?.decisions.filter((d) => d.action === 'recover') ?? [];
  return (
    <>
      {toRecover.slice(0, 3).map((d, i) => (
        <span key={i} className="block font-mono">
          {d.text.slice(0, 300)}
          {d.rule ? <span className="font-sans"> — known: {d.rule}</span> : null}
        </span>
      ))}
    </>
  );
}

/** One line on what the check is doing now, with the seconds it has taken. */
function CheckDetail({ page }: { page: PageCheck }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - page.checkStartedAt) / 1000));
  return page.phase === 'deciding' ? (
    <Trans>The page reported — Flowpad is matching its errors against setup/webapp_errors.json · {seconds}s (shown anyway at 8s)</Trans>
  ) : (
    <Trans>Waiting for the page to settle and report its errors · {seconds}s (shown anyway at 8s)</Trans>
  );
}

/**
 * The screen over the (hidden) app while its page is checked or recovered: each step says what happened
 * and what comes next. Gone once the page is usable.
 */
export function PageCheckPanel({ page, toolCount }: { page: PageCheck; toolCount: number }) {
  const { state, tried } = page;
  const title =
    state === 'checking' ? (
      <Trans>Opening your app…</Trans>
    ) : state === 'failed' ? (
      <Trans>We could not recover the app</Trans>
    ) : (
      <Trans>Your app crashed while loading — recovering it</Trans>
    );
  const lead =
    state === 'checking' ? (
      <Trans>The page is loading. It opens as soon as it loads without errors.</Trans>
    ) : state === 'failed' ? (
      <Trans>Here is what was tried. Try again, or open Edit app → Setup for the error log and learnings.</Trans>
    ) : (
      <Trans>Flowpad found an error in the page, so the app is not usable yet. Recovery started on its own.</Trans>
    );
  return (
    <div
      className="absolute inset-0 z-10 flex justify-center overflow-auto bg-background p-8"
      data-testid="page-check"
      data-state={state}
    >
      <div className="flex w-full max-w-xl flex-col gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{lead}</p>
        <ul className="flex flex-col divide-y rounded-md border">
          {state === 'checking' ? (
            <>
              <Step
                mark="running"
                title={<Trans>Check — loading the page and watching for errors</Trans>}
                detail={<CheckDetail page={page} />}
              />
              <Step
                mark="next"
                title={<Trans>Next: show the app</Trans>}
                detail={<Trans>Or recover it, if the page throws an error.</Trans>}
              />
            </>
          ) : (
            <>
              <Step
                mark="failed"
                title={<Trans>Check — the page threw an error while loading</Trans>}
                detail={<Errors page={page} />}
              />
              {tried.includes('restart') && (
                <Step
                  mark={state === 'restarting' ? 'running' : 'done'}
                  title={<Trans>Restart the app's server</Trans>}
                  detail={<Trans>A known fix for this error (setup/webapp_errors.json).</Trans>}
                />
              )}
              {tried.includes('agent') && (
                <Step
                  mark={state === 'recovering' ? 'running' : state === 'failed' ? 'failed' : 'done'}
                  title={<Trans>Recover — an agent repairs the app</Trans>}
                  detail={
                    state === 'recovering' ? (
                      <Trans>Reading setup/recovery.md first · {toolCount} steps so far</Trans>
                    ) : (
                      <Trans>It records what it learned in setup/recovery.md and setup/webapp_errors.json.</Trans>
                    )
                  }
                />
              )}
              {state !== 'failed' && (
                <Step
                  mark="next"
                  title={<Trans>Next: check again</Trans>}
                  detail={<Trans>The repair counts only when the page loads clean.</Trans>}
                />
              )}
            </>
          )}
        </ul>
        {state === 'failed' && (
          <div className="flex gap-2">
            <Button onClick={page.retry}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
