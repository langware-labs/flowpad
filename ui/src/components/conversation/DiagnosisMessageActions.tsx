import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Loader2, SquareTerminal } from 'lucide-react';
import { helpRequestReport } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { MESSAGE_ROW_ICON_BUTTON_CLASS } from '@src/components/workers/ContextWorkerToolbar';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useHelpRequestDiagnosis } from './use-help-request-diagnosis';

/**
 * Under a diagnosis message (its text is the bottom line): the ONE action its cause calls for -- Report it,
 * Report it to <the dependency's desk>, or Report it for me -- and the details, folded. Nothing is offered
 * when the cause is the person's own project or machine (``DiagnosisSpec.reportable``).
 */
export function DiagnosisMessageActions({ conversationId, isMine }: { conversationId: string; isMine: boolean }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [state, load] = useHelpRequestDiagnosis(conversationId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const report = async () => {
    setBusy(true);
    try {
      await helpRequestReport(conversationId);
      load();
    } catch (e: unknown) {
      notify.error({ title: t`Could not report it`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  const d = state?.diagnosis;
  const processId = state?.worker_process_id;
  const label = state?.pass_on
    ? t`Report it for me`
    : state?.desk && state.desk !== 'Flowpad support'
      ? t`Report it to ${state.desk}`
      : t`Report it`;

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="diagnosis-message-actions">
      {isMine && state?.reportable && (
        <div>
          <Button
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => void report()}
            disabled={busy}
            data-testid="diagnosis-report"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {label}
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        {d && (
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-testid="diagnosis-details-toggle"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {t`Details`}
          </button>
        )}
        {processId && (
          <button
            type="button"
            className={cn(MESSAGE_ROW_ICON_BUTTON_CLASS, 'opacity-100')}
            onClick={() => void navigation.openShellProcess(processId)}
            title={t`Open the diagnosis worker`}
            aria-label={t`Open the diagnosis worker`}
            data-testid="diagnosis-open-worker"
          >
            <SquareTerminal className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {d && open && (
        <dl className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs" data-testid="diagnosis-details">
          {[
            [t`What happened`, d.symptoms || d.summary],
            [t`Root cause`, d.rca],
            [d.status === 'needs_action' ? t`What to do` : t`What was done`, d.fix],
            [t`Cause`, d.cause_asset ? `${d.cause} — ${d.cause_asset}` : d.cause],
          ]
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="mb-1 last:mb-0">
                <dt className="font-medium text-foreground">{k}</dt>
                <dd className="whitespace-pre-wrap text-muted-foreground">{v}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  );
}
