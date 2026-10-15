import { useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { isCliResult, isOk, type CliResult, type ComputeOp, type FSRef, type ReturnedValue } from '@sdk';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { CommandRow } from '@src/components/assets/editor/wizard/WizardStepInspector';
import { Button } from '@src/components/ui/button';
import { useJsonDoc } from '@src/hooks/use-json-doc';

const MAIN_FILE = 'compute_op.json';
const SETUP_FILE = 'setup.md';

interface CliDoc {
  commands?: Record<string, string>;
  timeout_seconds?: number;
}

interface ComputeOpDoc {
  name?: string;
  label?: string;
  description?: string;
  subkind?: string;
  output_spec_kind?: string;
  exe_data?: CliDoc & Record<string, unknown>;
  completion_check?: CliDoc;
}

/**
 * A compute op as it is: what it does, how it is judged done, and the two things it can be asked —
 * Check (is it done?) and Run. Both are the op's own actions; nothing here edits the document.
 */
export function ComputeOpViewer({ op, fsRef }: { op: ComputeOp; fsRef: FSRef }) {
  const { doc } = useJsonDoc<ComputeOpDoc>(useMemo(() => fsRef.child(MAIN_FILE), [fsRef]));
  const { data: setupNotes } = useQuery({
    queryKey: ['compute-op-setup-notes', fsRef.path],
    queryFn: () => fsRef.child(SETUP_FILE).read().catch(() => ''),
  });
  const shipped = op.shipped;
  const [check, setCheck] = useState<CliResult | null>(null);
  const [ran, setRan] = useState<ReturnedValue | null>(null);
  const [busy, setBusy] = useState<'check' | 'run' | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (which: 'check' | 'run') => {
    setBusy(which);
    setError(null);
    try {
      // Our own ops run unprompted; anyone else's runs only because the person said so, just now.
      if (which === 'check') setCheck(await op.check());
      else setRan(await op.run(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const run = () => (shipped ? void call('run') : setConfirmRun(true));
  const commands = Object.entries(doc?.exe_data?.commands ?? {});
  const checks = Object.entries(doc?.completion_check?.commands ?? {});
  const others = Object.entries(doc?.exe_data ?? {}).filter(([key]) => key !== 'commands');

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="compute-op-viewer">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="truncate text-sm font-medium">{doc?.label || doc?.name}</span>
        {doc?.subkind && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{doc.subkind}</span>}
        {shipped && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Trans>shipped</Trans>
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void call('check')} data-testid="compute-op-check">
          {busy === 'check' && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          <Trans>Check</Trans>
        </Button>
        <Button size="sm" disabled={!!busy} onClick={run} data-testid="compute-op-run">
          {busy === 'run' && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          <Trans>Run</Trans>
        </Button>
      </header>

      <div className="flex flex-col gap-5 px-4 py-3 text-sm">
        {doc?.description && <p className="text-muted-foreground">{doc.description}</p>}

        {confirmRun && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2" data-testid="compute-op-confirm">
            <p>
              <Trans>This op does not ship with Flowpad. Running it runs its commands on this computer.</Trans>
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => (setConfirmRun(false), void call('run'))} data-testid="compute-op-confirm-run">
                <Trans>Run it</Trans>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRun(false)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs" role="alert">
            {error}
          </p>
        )}

        {(check || ran) && (
          <section data-testid="compute-op-result">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Trans>Result</Trans>
            </h3>
            <ul>
              {ran && (
                <li className="py-2" data-testid="compute-op-ran">
                  <span className={isOk(ran) ? '' : 'rounded border-l-2 border-red-500 bg-red-500/15 px-2 py-0.5'}>
                    {ran.detail || (isOk(ran) ? <Trans>Done.</Trans> : <Trans>Not done.</Trans>)}
                  </span>
                </li>
              )}
              {ran && isCliResult(ran) && <CommandRow role="call" run={ran} />}
              {ran?.check && !check && <CommandRow role="check" run={ran.check} />}
              {check && <CommandRow role="check" run={check} />}
            </ul>
          </section>
        )}

        <Commands title={<Trans>What it runs</Trans>} commands={commands} testId="compute-op-commands" />
        {others.length > 0 && (
          <section data-testid="compute-op-settings">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              {others.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
                  <dd className="break-all font-mono text-xs">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <Commands title={<Trans>How it is judged done</Trans>} commands={checks} testId="compute-op-checks" />

        {setupNotes?.trim() && (
          <section data-testid="compute-op-setup-notes">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Trans>Setup notes</Trans>
            </h3>
            <pre className="whitespace-pre-wrap text-sm">{setupNotes}</pre>
          </section>
        )}
      </div>
    </div>
  );
}

function Commands({ title, commands, testId }: { title: React.ReactNode; commands: [string, string][]; testId: string }) {
  if (!commands.length) return null;
  return (
    <section data-testid={testId}>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {commands.map(([os, command]) => (
          <div key={os} className="contents">
            <dt className="font-mono text-xs text-muted-foreground">{os}</dt>
            <dd className="break-all font-mono text-xs">{command}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
