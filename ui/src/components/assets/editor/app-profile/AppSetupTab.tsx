import { Trans } from '@lingui/react/macro';
import { Check, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HANDLING_ACTIONS, type WebApp, type WebAppHandling, type WebAppHandlingAction, type WebAppSetupState } from '@sdk';
import { Button } from '@src/components/ui/button';

function Section({ title, children, testId }: { title: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ lead, title, detail }: { lead: ReactNode; title: ReactNode; detail?: ReactNode }) {
  return (
    <li className="flex gap-3 px-3 py-2">
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{lead}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm">{title}</div>
        {detail && <div className="break-words text-xs text-muted-foreground">{detail}</div>}
      </div>
    </li>
  );
}

/** Recovery instructions, newest learnings first: each `## ` heading of recovery.md is one learning. */
function learnings(markdown: string): { title: string; body: string }[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [title, ...rest] = chunk.split('\n');
      return { title: title.trim(), body: rest.join(' ').replace(/\s+/g, ' ').trim() };
    })
    .reverse();
}

/**
 * The app editor's Setup tab: where the app is on this machine (its lifecycle record), how it comes up, what
 * recovery learned (`setup/recovery.md`), the learned handlings (`setup/webapp_handlings.json`, each one an
 * action from a closed set), the ones Flowpad ships, and the failure log.
 */
export function AppSetupTab({ app }: { app: WebApp }) {
  const [state, setState] = useState<WebAppSetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setState(await app.setupState().catch(() => null));
    setLoading(false);
  }, [app]);
  useEffect(() => void load(), [load]);

  const flip = async (rule: string, action: WebAppHandlingAction) => {
    const next = await app.setRuleAction(rule, action).catch(() => null);
    if (next) setState(next);
  };
  const record = state?.lifecycle ?? null;
  const showable = record?.state === 'up' || record?.state === 'degraded';
  const learned = learnings(state?.recovery_md ?? '');

  return (
    <div className="grid grid-cols-1 items-start gap-6 px-6 py-5 lg:grid-cols-2" data-testid="app-setup-tab">
      <Section title={<Trans>Setup</Trans>} testId="app-setup-status">
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          {!record ? (
            <span className="flex-1 text-muted-foreground">
              <Trans>Not run on this machine yet</Trans>
            </span>
          ) : showable ? (
            <>
              <Check className="size-4 text-emerald-400" />
              <span className="flex-1" data-testid="app-setup-record-state" data-state={record.state}>
                {record.state === 'degraded' ? <Trans>Up, with problems: {record.detail}</Trans> : <Trans>Up</Trans>}
                {record.checked_at ? <span className="text-muted-foreground"> · {record.checked_at}</span> : null}
              </span>
            </>
          ) : (
            <>
              <X className="size-4 text-destructive" />
              <span className="flex-1" data-testid="app-setup-record-state" data-state={record.state}>
                {record.state} {record.failure?.text || record.detail ? `· ${record.failure?.text || record.detail}` : ''}
              </span>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RotateCw className="size-3.5" />
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </Section>

      <Section title={<Trans>How it comes up</Trans>} testId="app-setup-structure">
        <ul className="flex flex-col divide-y rounded-md border">
          <Row
            lead="check"
            title={<Trans>Is it usable?</Trans>}
            detail={<Trans>The page loads and reports its errors; each is matched against the handlings below.</Trans>}
          />
          <Row
            lead="start"
            title={<Trans>Start or restart</Trans>}
            detail={<Trans>The start command; a handling whose action is “restart” restarts it without an agent.</Trans>}
          />
          <Row
            lead="recover"
            title={<Trans>Repair with an agent</Trans>}
            detail={<Trans>Reads and updates setup/recovery.md and setup/webapp_handlings.json.</Trans>}
          />
        </ul>
      </Section>

      <Section title={<Trans>Learnings — recovery.md</Trans>} testId="app-setup-learnings">
        {learned.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {learned.map((l, i) => (
              <Row key={i} lead={i === 0 ? 'new' : ''} title={l.title} detail={l.body.slice(0, 400)} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>Nothing learned yet. Each recovery adds what it learns here — only when it is new.</Trans>
          </p>
        )}
      </Section>

      <Section title={<Trans>Handlings — webapp_handlings.json</Trans>} testId="app-setup-rules">
        {state?.handlings_problem ? (
          <p role="alert" className="text-sm text-destructive">
            {state.handlings_problem}
          </p>
        ) : state?.handlings.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {state.handlings.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2" data-testid={`app-setup-rule-${h.id}`}>
                <HandlingText handling={h} />
                <select
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                  value={h.action}
                  aria-label={h.id}
                  data-testid={`app-setup-rule-action-${h.id}`}
                  onChange={(event) => void flip(h.id, event.target.value as WebAppHandlingAction)}
                >
                  {HANDLING_ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No handlings yet. A failure no handling knows goes to recovery, which adds one for it.</Trans>
          </p>
        )}
      </Section>

      <Section title={<Trans>Shipped handlings</Trans>} testId="app-setup-shipped">
        {state?.shipped.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {state.shipped.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                <HandlingText handling={h} />
                <span className="font-mono text-xs text-muted-foreground">{h.action}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>None.</Trans>
          </p>
        )}
      </Section>

      <Section title={<Trans>Errors</Trans>} testId="app-setup-errors">
        {state?.errors.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {state.errors.slice(0, 20).map((e, i) => (
              <Row
                key={i}
                lead={e.action === 'ignore' ? 'ignored' : e.outcome}
                title={<span className="font-mono text-xs">{e.text.slice(0, 240)}</span>}
                detail={`${e.at} · ${e.phase ? `${e.phase} · ` : ''}${e.source}${e.handling ? ` · ${e.handling}` : ' · unknown'}`}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No errors recorded.</Trans>
          </p>
        )}
      </Section>
    </div>
  );
}

function HandlingText({ handling }: { handling: WebAppHandling }) {
  const match = handling.fingerprint ? `#${handling.fingerprint.slice(0, 12)}` : `/${handling.pattern}/`;
  return (
    <div className="min-w-0 flex-1">
      <div className="text-sm">{handling.id}</div>
      <div className="break-words font-mono text-xs text-muted-foreground">
        {match}
        {handling.code ? ` · ${handling.code}` : ''} · fixed {handling.fixed} · not fixed {handling.not_fixed}
      </div>
    </div>
  );
}
