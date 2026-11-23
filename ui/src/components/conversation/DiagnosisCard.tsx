import { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import {
  type HelpContextItem,
  type HelpRequestDiagnosis,
  archiveConversation,
  helpRequestFix,
  helpRequestHeld,
  helpRequestReport,
  helpRequestShare,
} from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { OpenSessionButton } from '@src/components/workers/ContextWorkerToolbar';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { useDiagnosisLinks } from '@src/notifications/alerts-store';
import { ContentReviewDialog } from './asset-review/ContentReviewDialog';
import { CardLine, DetailsList, DetailsToggle } from './StatusCard';
import { useHelpRequestDiagnosis } from './use-help-request-diagnosis';

type State = HelpRequestDiagnosis['state'];
const TONE: Record<State, 'warning' | 'success' | 'muted'> = {
  diagnosing: 'warning',
  open: 'warning',
  fixing: 'warning',
  help_requested: 'warning',
  fixed: 'success',
  ok: 'success',
  done: 'muted',
};

/**
 * A help request and its diagnosis, as ONE card on the request's message: where it stands (the chip), the
 * issue and the root cause in a line each, the rest folded under Details, and what the person can do next --
 * Fix (only when the diagnosis can apply its fix here), Ask for help, Done.
 */
export function DiagnosisCard({ conversationId, isMine }: { conversationId: string; isMine: boolean }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [state, reload] = useHelpRequestDiagnosis(conversationId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [held, setHeld] = useState<HelpContextItem[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);

  const loadHeld = useCallback(() => {
    if (!isMine || !conversationId) return;
    void helpRequestHeld(conversationId)
      .then((h) => {
        setHeld(h.items);
        setIsPrivate(h.private);
      })
      .catch(() => setHeld([]));
  }, [conversationId, isMine]);
  useEffect(loadHeld, [loadHeld]);

  /** One button press: run it, say why when it fails, then read the card's state again. */
  const act = async (name: string, failed: string, run: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await run();
      loadHeld();
      reload();
    } catch (e: unknown) {
      notify.error({ title: failed, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setBusy('');
    }
  };

  const share = () => void act('share', t`Could not share`, () => helpRequestShare(conversationId, leftOut));

  if (!state) return null;
  const d = state.diagnosis;
  const s = state.state;
  const running = s === 'diagnosing' || s === 'fixing';
  const label: Record<State, string> = {
    diagnosing: t`Diagnosing`,
    open: t`Open`,
    fixing: t`Fixing`,
    fixed: t`Fixed`,
    help_requested: t`Help requested`,
    ok: t`No problem found`,
    done: t`Done`,
  };
  const rootCause = d ? d.title || d.summary : running ? t`Looking into it…` : t`The diagnosis could not run.`;
  const bug = d?.bug ? [d.bug.package, d.bug.version].filter(Boolean).join(' ') + (d.bug.suspected ? `\n${d.bug.suspected}` : '') : '';
  const env = d?.environment;
  const rows: [string, React.ReactNode][] = [
    [t`Request`, state.request],
    [t`What happened`, d?.symptoms || d?.summary],
    [t`Root cause`, d?.rca],
    [d?.status === 'fixed' ? t`What was done` : t`Suggested fix`, d?.fix],
    [t`Whose it is`, d ? (d.cause_asset ? `${d.cause} — ${d.cause_asset}` : d.cause) : ''],
    [t`Suspected bug`, bug],
    [t`Also noticed`, (d?.findings ?? []).map((f) => f.title).join('\n')],
    [t`Environment`, env ? [env.os, env.app_version && `Flowpad ${env.app_version}`, env.instance].filter(Boolean).join(' · ') : ''],
    [
      t`Context`,
      held.length > 0 && (
        <span className="flex items-center gap-2" data-testid="help-request-not-shared">
          {t`Not shared`}
          {!isPrivate && (
            <button
              type="button"
              className="rounded-md border border-input bg-background px-2 py-0.5 font-medium text-foreground shadow-sm hover:bg-accent"
              onClick={share}
              disabled={busy === 'share'}
              data-testid="help-request-share"
            >
              {busy === 'share' ? t`Sharing…` : t`Share`}
            </button>
          )}
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => setReviewOpen(true)}
            data-testid="help-request-open"
          >
            {t`Open`}
          </button>
        </span>
      ),
    ],
  ];
  const done = async () => {
    await archiveConversation({ conversation_id: conversationId });
    useDiagnosisLinks.getState().markDone(conversationId);
  };
  // What the person can do next, in order; each shows only where it applies.
  const actions = [
    {
      name: 'fix',
      label: t`Fix`,
      failed: t`Could not start the fix`,
      run: () => helpRequestFix(conversationId),
      show: s === 'open' && !!d?.local_fix && !!state.worker_process_id,
    },
    {
      name: 'ask',
      label: t`Ask for help`,
      failed: t`Could not ask for help`,
      run: () => helpRequestReport(conversationId),
      show: !state.reported && (s === 'open' || s === 'fixed' || s === 'ok'),
      title: state.desk ? t`Opens a support conversation with ${state.desk}` : undefined,
    },
    { name: 'done', label: t`Done`, failed: t`Could not mark it done`, run: done, show: !running && s !== 'done' },
  ].filter((a) => isMine && a.show);

  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="diagnosis-card" data-state={s}>
      <div className="space-y-1 break-words">
        <CardLine name={t`Status`}>
          <Badge variant={TONE[s]} className="gap-1" data-testid="diagnosis-status">
            {running && <Loader2 className="h-3 w-3 animate-spin" />}
            {label[s]}
          </Badge>
        </CardLine>
        <CardLine name={t`Issue`}>{state.issue || state.request.split('\n')[0]}</CardLine>
        <CardLine name={t`Root cause`}>{rootCause}</CardLine>
      </div>
      <div className="flex items-center gap-2">
        <DetailsToggle open={open} onToggle={() => setOpen((v) => !v)} testId="diagnosis-details-toggle" />
        {state.worker_process_id && (
          <OpenSessionButton
            onOpen={() => void navigation.openShellProcess(state.worker_process_id)}
            title={t`Open the diagnosis worker`}
            name={state.worker_process_name}
            testIdPrefix="diagnosis"
          />
        )}
      </div>
      {open && <DetailsList rows={rows} testId="diagnosis-details" />}
      {actions.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5">
          {actions.map((a) => (
            <Button
              key={a.name}
              size="sm"
              variant={a.name === 'fix' ? 'default' : 'outline'}
              className="h-7 px-3 text-xs"
              disabled={!!busy}
              onClick={() => void act(a.name, a.failed, a.run)}
              title={a.title}
              data-testid={`diagnosis-${a.name}`}
            >
              {busy === a.name && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {reviewOpen && (
        <ContentReviewDialog
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          items={held}
          leftOut={leftOut}
          onLeftOutChange={setLeftOut}
          onShare={share}
        />
      )}
    </div>
  );
}
