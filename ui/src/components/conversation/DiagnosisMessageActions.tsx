import { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { type HelpRequestDiagnosis, helpRequestDiagnosis, helpRequestReport } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * Under a diagnosis message (its text is the bottom line): the ONE action its cause calls for -- Report it,
 * Report it to <the dependency's desk>, or Report it for me -- and the details, folded. Nothing is offered
 * when the cause is the person's own project or machine (``DiagnosisSpec.reportable``).
 */
export function DiagnosisMessageActions({ conversationId, isMine }: { conversationId: string; isMine: boolean }) {
  const { t } = useLingui();
  const [state, setState] = useState<HelpRequestDiagnosis | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!conversationId) return;
    void helpRequestDiagnosis(conversationId)
      .then(setState)
      .catch(() => setState(null));
  }, [conversationId]);
  useEffect(load, [load]);

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
      {d && (
        <button
          type="button"
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="diagnosis-details-toggle"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t`Details`}
        </button>
      )}
      {d && open && (
        <dl className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs" data-testid="diagnosis-details">
          {[
            [t`What happened`, d.symptoms || d.summary],
            [t`Root cause`, d.rca],
            [t`What was done`, d.fix],
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
