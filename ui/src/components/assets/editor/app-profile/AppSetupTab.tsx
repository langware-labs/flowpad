import { Trans } from '@lingui/react/macro';
import { Check, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { WebApp, WebAppSetupState } from '@sdk';
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
 * The app editor's Setup tab: how the app comes up, what recovery learned (`setup/recovery.md`), the error
 * rules (`setup/webapp_errors.json`, each one ignore or recover) and the error log.
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

  const flip = async (rule: string, action: 'ignore' | 'recover') => {
    const next = await app.setRuleAction(rule, action).catch(() => null);
    if (next) setState(next);
  };
  const check = state?.last_check ?? null;
  const learned = learnings(state?.recovery_md ?? '');

  return (
    <div className="grid grid-cols-1 items-start gap-6 px-6 py-5 lg:grid-cols-2" data-testid="app-setup-tab">
      <Section title={<Trans>Setup</Trans>} testId="app-setup-status">
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          {!app.report_errors ? (
            <span className="flex-1 text-muted-foreground">
              <Trans>Page errors are not reported — the app opens without a check.</Trans>
            </span>
          ) : check && !check.usable ? (
            <>
              <X className="size-4 text-destructive" />
              <span className="flex-1">
                <Trans>
                  Last check found {check.errors} error(s) · {check.at}
                </Trans>
              </span>
            </>
          ) : (
            <>
              <Check className="size-4 text-emerald-400" />
              <span className="flex-1">
                {check ? <Trans>Ready · last check {check.at}</Trans> : <Trans>Not checked yet</Trans>}
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
            detail={<Trans>The page loads and reports its errors; each is decided by the rules below.</Trans>}
          />
          <Row
            lead="start"
            title={<Trans>Start or restart</Trans>}
            detail={<Trans>The start command; a rule whose fix is “restart” restarts it without an agent.</Trans>}
          />
          <Row
            lead="recover"
            title={<Trans>Repair with an agent</Trans>}
            detail={<Trans>Reads and updates setup/recovery.md and setup/webapp_errors.json.</Trans>}
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

      <Section title={<Trans>Error rules — webapp_errors.json</Trans>} testId="app-setup-rules">
        {state?.rules.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {state.rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2" data-testid={`app-setup-rule-${r.id}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{r.id}</div>
                  <div className="break-words font-mono text-xs text-muted-foreground">
                    /{r.pattern}/ {r.fix ? `· fix: ${r.fix}` : ''} · seen {r.seen}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={r.action === 'recover' ? 'default' : 'outline'}
                  onClick={() => void flip(r.id, 'recover')}
                >
                  <Trans>Recover</Trans>
                </Button>
                <Button
                  size="sm"
                  variant={r.action === 'ignore' ? 'default' : 'outline'}
                  onClick={() => void flip(r.id, 'ignore')}
                >
                  <Trans>Ignore</Trans>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No rules yet. An error no rule knows goes to recovery, which adds a rule for it.</Trans>
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
                detail={`${e.at} · ${e.source}${e.rule ? ` · rule ${e.rule}` : ' · unknown'}`}
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
