/**
 * One diagnosis request: the command to send, what it accepts, what was sent along, and the runs
 * that came back. Fileless (`FILELESS_EDITORS`): the row is local, but the attachments and runs
 * live in the request's hub storage and are read through the type's actions -- `runs` also
 * refreshes the row from the hub, so the counts here follow it.
 */
import { DiagnosisRequest, TypeId } from '@sdk';
import { useAction } from '@src/hooks/use-action';
import { useEntity } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useRef, useState, type ReactNode } from 'react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { cn } from '@src/lib/utils';

import {
  callRequestAction,
  commandFor,
  errorText,
  formatSize,
  formatWhen,
  readFile,
  requestAction,
  type RequestAttachment,
  type RunDetail,
  type RunSummary,
} from './diagnosis-request-api';

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-44 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words', mono && 'font-mono text-xs')}>{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Attachments({ id }: { id: string }) {
  const { t } = useLingui();
  const action = useMemo(() => requestAction('attachments', { id }), [id]);
  const { data, error, refetch } = useAction<RequestAttachment[]>(action);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const items = data ?? [];

  const sendMore = async (files: File[]) => {
    setBusy(true);
    setUploadError(null);
    try {
      for (const file of files) {
        await callRequestAction('attachments', { id, method: 'POST', body: await readFile(file) });
      }
      await refetch();
    } catch (e) {
      setUploadError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Section title={<Trans>Sent along</Trans>}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing attached.</Trans>
        </p>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="diagnosis-request-attachments">
          {items.map((a) => (
            <li key={`${a.kind}/${a.name}`} className="flex items-center gap-2">
              <Badge variant="secondary">{a.kind === 'skills' ? t`Skill` : t`File`}</Badge>
              <span className="font-mono text-xs" dir="ltr">
                {a.name}
              </span>
              <span className="text-xs text-muted-foreground" dir="ltr">
                {formatSize(a.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void sendMore([...(e.target.files ?? [])])}
        data-testid="diagnosis-request-more-files"
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        <Trans>Send more files</Trans>
      </Button>
      {(uploadError || error) && <p className="text-xs text-destructive">{uploadError ?? errorText(error)}</p>}
    </Section>
  );
}

function RunBody({ id, number }: { id: string; number: number }) {
  const { t } = useLingui();
  const action = useMemo(() => requestAction('runs', { id, subpath: String(number) }), [id, number]);
  const { data: run, error, isLoading } = useAction<RunDetail>(action);

  if (isLoading || (!run && !error)) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  if (error || !run) return <p className="text-sm text-destructive">{errorText(error)}</p>;

  const parts: [string, string | null | undefined][] = [
    [t`Summary`, run.summary],
    [t`They reported`, run.user_report],
    [t`Symptoms`, run.symptoms],
    [t`Root cause`, run.rca],
    [t`Fix`, run.fix],
  ];
  return (
    <article className="space-y-3 rounded-md border p-3" data-testid="diagnosis-request-run">
      <p className="text-xs text-muted-foreground">
        {[formatWhen(run.at), run.reported_by, run.os, run.app_version && `Flowpad ${run.app_version}`]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {parts
        .filter(([, text]) => text)
        .map(([label, text]) => (
          <div key={label}>
            <h4 className="text-sm font-medium">{label}</h4>
            <p className="whitespace-pre-wrap text-sm">{text}</p>
          </div>
        ))}
      {Object.entries(run.files ?? {}).map(([name, text]) => (
        <div key={name}>
          <h4 className="font-mono text-xs font-medium" dir="ltr">
            {name}
          </h4>
          <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs" dir="auto">
            {text}
          </pre>
        </div>
      ))}
    </article>
  );
}

function Runs({ id }: { id: string }) {
  const { t } = useLingui();
  const action = useMemo(() => requestAction('runs', { id }), [id]);
  const { data, error, isLoading } = useAction<RunSummary[]>(action);
  const [selected, setSelected] = useState<number | null>(null);
  const runs = [...(data ?? [])].reverse();

  return (
    <Section title={<Trans>Runs</Trans>}>
      {error ? (
        <p className="text-sm text-destructive">{t`Could not read the runs: ${errorText(error)}`}</p>
      ) : isLoading && !data ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing has been sent yet.</Trans>
        </p>
      ) : (
        <ol className="space-y-1" data-testid="diagnosis-request-runs">
          {runs.map((run) => {
            const title = run.title || t`Diagnosis request`;
            const files = run.files.length;
            return (
              <li key={run.run}>
                <button
                  type="button"
                  aria-current={selected === run.run ? 'true' : undefined}
                  onClick={() => setSelected(run.run)}
                  className={cn(
                    'flex w-full flex-col items-start rounded-md border px-3 py-2 text-start hover:bg-muted',
                    selected === run.run && 'border-primary/50 bg-primary/5',
                  )}
                >
                  <span className="text-sm">
                    #{run.run} — {title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatWhen(run.at)} · {t`Files: ${files}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {selected != null && <RunBody id={id} number={selected} />}
    </Section>
  );
}

export interface DiagnosisRequestViewProps {
  /** The request's typeid (`diagnosis_request-<uuid>`). */
  value: string;
}

export function DiagnosisRequestView({ value }: DiagnosisRequestViewProps) {
  const { t } = useLingui();
  const typeId = useMemo(() => new TypeId(value), [value]);
  const { data: request, isLoading } = useEntity<DiagnosisRequest>(typeId);
  // The type's glyph comes from the backend registry, never a literal (CLAUDE.md's icon law).
  const Icon = iconForType(DiagnosisRequest.type);
  const id = typeId.id;

  if (isLoading && !request) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  if (!request) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>This diagnosis request no longer exists.</Trans>
      </div>
    );
  }

  const command = commandFor(id);
  return (
    <div className="h-full overflow-auto p-4" data-testid="diagnosis-request-view">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{request.title || request.name || t`Diagnosis request`}</h2>
        </div>

        <Section title={<Trans>Send this to the person you support — they run it in their terminal:</Trans>}>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <code className="flex-1 font-mono text-sm" dir="ltr" data-testid="diagnosis-request-command">
              {command}
            </code>
            <CopyButton value={command} testId="diagnosis-request-copy" />
          </div>
        </Section>

        <dl className="grid grid-cols-1 gap-y-1 text-sm">
          <Field label={t`Accepts runs until`}>{formatWhen(request.write_expires_at)}</Field>
          <Field label={t`LLM budget`} mono={!!request.llm_endpoint_typeid}>
            {request.llm_endpoint_typeid || t`none — they use their own`}
          </Field>
          <Field label={t`Runs`}>{String(request.run_count ?? 0)}</Field>
        </dl>

        {request.instructions && (
          <Section title={<Trans>Instructions</Trans>}>
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{request.instructions}</pre>
          </Section>
        )}

        <Attachments id={id} />
        <Runs id={id} />
      </div>
    </div>
  );
}
