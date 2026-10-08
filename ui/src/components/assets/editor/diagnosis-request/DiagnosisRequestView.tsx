/**
 * One diagnosis request: the command to send, its settings -- edited in place
 * (`DiagnosisRequestFields`) -- what was sent along, and the runs that came back. Fileless (`FILELESS_EDITORS`): the row is local, but the attachments and runs
 * live in the request's hub storage and are read through the type's actions -- `runs` also
 * refreshes the row from the hub, so the counts here follow it.
 */
import { DiagnosisRequest, TypeId, type AssetDescriptor } from '@sdk';
import { useAction } from '@src/hooks/use-action';
import { useEntity } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

import { AttachMenu } from '@src/components/conversation/AttachMenu';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { useStartVibeSession } from '@src/pages/flow-page/use-start-vibe-session';

import { isAttachable } from './DiagnosisRequestCreateDialog';
import { BudgetField, InstructionsField, LimitsFields } from './DiagnosisRequestFields';
import { ErrorLine } from './ErrorLine';
import {
  callRequestAction,
  commandFor,
  errorText,
  explainPrompt,
  formatSize,
  formatWhen,
  readFile,
  requestAction,
  type AttachmentBody,
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
  const items = data ?? [];

  // Each pick is sent at once -- the request is already open, there is no draft to collect into.
  const send = async (bodies: Promise<AttachmentBody>[]) => {
    if (bodies.length === 0) return;
    setBusy(true);
    setUploadError(null);
    try {
      for (const body of bodies) {
        await callRequestAction('attachments', { id, method: 'POST', body: await body });
      }
      await refetch();
    } catch (e) {
      setUploadError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const sendFiles = (files: FileList | null) => void send([...(files ?? [])].map(readFile));
  const sendAssets = (picked: AssetDescriptor[]) =>
    void send(picked.map((a) => Promise.resolve({ asset_typeid: a.typeid })));

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
      {/* The same Attach button a message has: files from this computer, or Flowpad assets. */}
      <div className="flex items-center gap-2" data-testid="diagnosis-request-attach">
        <AttachMenu
          assetRefs={[]}
          onAssetRefsChange={sendAssets}
          onFilesPicked={sendFiles}
          disabled={busy}
          hideAssetList
          assetFilter={isAttachable}
        />
        <span className="text-xs text-muted-foreground">
          {busy ? <Trans>Sending…</Trans> : <Trans>Attach more files or assets</Trans>}
        </span>
      </div>
      {(uploadError || error) && <ErrorLine error={uploadError ?? errorText(error)} />}
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
  if (error || !run) return <ErrorLine error={errorText(error)} />;

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

/** Opens a new session seeded with the whole request and every run, asked to summarize and explain it. */
function ExplainButton({ request }: { request: DiagnosisRequest }) {
  const { t } = useLingui();
  const { start, installDialog } = useStartVibeSession();
  const [busy, setBusy] = useState(false);

  const explain = async () => {
    setBusy(true);
    try {
      const id = request.id;
      const [summaries, attachments] = await Promise.all([
        callRequestAction<RunSummary[]>('runs', { id }),
        callRequestAction<RequestAttachment[]>('attachments', { id }),
      ]);
      const runs = await Promise.all(
        summaries.map((r) => callRequestAction<RunDetail>('runs', { id, subpath: String(r.run) })),
      );
      const { message, files } = explainPrompt(request, attachments, runs);
      start(message, files);
    } catch (e) {
      notify.error({ title: t`Could not read the diagnosis`, message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" disabled={busy} onClick={() => void explain()} data-testid="diagnosis-request-explain">
        <Sparkles className="me-1.5 h-3.5 w-3.5" />
        <Trans>Explain the result</Trans>
      </Button>
      {installDialog}
    </>
  );
}

export function Runs({ id, runCount }: { id: string; runCount: number }) {
  const { t } = useLingui();
  const action = useMemo(() => requestAction('runs', { id }), [id]);
  const { data, error, isLoading, refetch } = useAction<RunSummary[]>(action);
  // A run arrives by the hub push, which updates the row (`run_count`) live -- not this list.
  const seen = useRef(runCount);
  useEffect(() => {
    if (runCount === seen.current) return;
    seen.current = runCount;
    void refetch();
  }, [runCount, refetch]);
  const [selected, setSelected] = useState<number | null>(null);
  const runs = [...(data ?? [])].reverse();

  return (
    <Section title={<Trans>Runs</Trans>}>
      {error ? (
        <ErrorLine error={t`Could not read the runs: ${errorText(error)}`} />
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

        <div className="space-y-2 text-sm">
          <LimitsFields request={request} />
          <BudgetField request={request} />
          <dl>
            <Field label={t`Runs`}>{String(request.run_count ?? 0)}</Field>
          </dl>
        </div>

        <Section title={<Trans>Instructions for their agent</Trans>}>
          <InstructionsField request={request} />
        </Section>

        <Attachments id={id} />
        {(request.run_count ?? 0) > 0 && <ExplainButton request={request} />}
        <Runs id={id} runCount={request.run_count ?? 0} />
      </div>
    </div>
  );
}
