import { DiagnosisActionButtons } from '@src/components/diagnose/diagnosis-action-buttons';
import {
  copyToClipboard,
  FlowpadDiagnosis,
  sendDiagnosisEmailReport,
  sendDiagnosisReport,
  TypeId,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { notify } from '@src/notifications';
import { Copy, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface DiagnosisDetailsProps {
  /** The FlowpadDiagnosis entity id (UUID, no type prefix). */
  diagnosisId: string;
  /** The suggested support conversation — enables the report buttons (issue only). */
  conversationId?: string;
  /** The recorded support FlowMessage — its text is the full formatted report on Forward. */
  flowMessageId?: string;
  /** Called after a successful report/forward send (e.g. the modal closes). */
  onActionDone?: () => void;
  /**
   * Typography scale. `'modal'` (default) is the compact popup body; `'page'` is
   * the full-tab reading layout — larger font, looser line spacing, more air
   * between sections, to match the other full-screen entity viewers.
   */
  variant?: 'modal' | 'page';
}

interface Field {
  label: string;
  value?: string;
}

/** The four labelled diagnosis fields, in display order. */
function diagnosisFields(diag: FlowpadDiagnosis): Field[] {
  return [
    { label: 'Summary', value: diag.summary },
    { label: 'Symptoms', value: diag.symptoms },
    { label: 'Root cause', value: diag.rca },
    { label: 'Fix', value: diag.fix },
  ];
}

/**
 * Assemble the full diagnosis (title + all fields) as one plain-text blob for the
 * clipboard. Shared by the details body's Copy button and the settings table's
 * per-row Copy-all action.
 */
export function diagnosisToText(diag: FlowpadDiagnosis): string {
  const title = diag.title || diag.name || 'Diagnosis';
  const body = diagnosisFields(diag)
    .filter((f) => f.value)
    .map((f) => `${f.label}:\n${f.value}`)
    .join('\n\n');
  return body ? `${title}\n\n${body}` : title;
}

/**
 * The shared diagnosis body — title, the four fields (summary / symptoms / root
 * cause / fix), a Copy-all button, and (for a real issue) the same Report/Forward
 * buttons as a Feed entry. Rendered identically by the popup
 * (`DiagnosisReportModal`), the routed full-tab viewer (`DiagnosisViewer`), and
 * the feed's View action, so the three never diverge. Report routes through the
 * shared `sendDiagnosisReport` — the single report path.
 */
export function DiagnosisDetails({
  diagnosisId,
  conversationId,
  flowMessageId,
  onActionDone,
  variant = 'modal',
}: DiagnosisDetailsProps) {
  const isPage = variant === 'page';
  const typeId = useMemo(
    () => (diagnosisId ? new TypeId(FlowpadDiagnosis.type, diagnosisId) : null),
    [diagnosisId],
  );
  const { data: diag, isLoading } = useEntity<FlowpadDiagnosis>(typeId, { enabled: !!typeId });

  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | undefined>(undefined);

  const fields: Field[] = diag ? diagnosisFields(diag) : [];

  const handleCopy = useCallback(async () => {
    if (!diag) return;
    await copyToClipboard(diagnosisToText(diag));
    notify.success({ title: 'Diagnosis copied to clipboard' });
  }, [diag]);

  // "Report issue" — email the diagnosis to the Flowpad team.
  const handleReportIssue = useCallback(async () => {
    if (!diagnosisId) return;
    setReporting(true);
    setReportError(undefined);
    try {
      await sendDiagnosisEmailReport(diagnosisId);
      onActionDone?.();
    } catch (e) {
      setReportError(e instanceof Error ? e.message : 'Failed to send report');
    } finally {
      setReporting(false);
    }
  }, [diagnosisId, onActionDone]);

  // "Forward" — post the formatted report into the chosen conversation.
  const handleForward = useCallback(
    async (targetConversationId: string) => {
      setReporting(true);
      setReportError(undefined);
      try {
        await sendDiagnosisReport(targetConversationId, {
          flowMessageId,
          fallbackText: diag?.summary || diag?.title || '',
        });
        onActionDone?.();
      } catch (e) {
        setReportError(e instanceof Error ? e.message : 'Failed to send report');
      } finally {
        setReporting(false);
      }
    },
    [diag, flowMessageId, onActionDone],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading diagnosis…</span>
      </div>
    );
  }

  if (!diag) {
    return <p className="text-xs text-muted-foreground">Diagnosis not found.</p>;
  }

  return (
    <div className={isPage ? 'space-y-8' : 'space-y-3'}>
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          title="Copy diagnosis to clipboard"
          aria-label="Copy diagnosis to clipboard"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </button>
      </div>

      <div className={isPage ? 'space-y-7' : 'space-y-3'}>
        {fields
          .filter((f) => f.value)
          .map((f) => (
            <div key={f.label} className={isPage ? 'space-y-2' : undefined}>
              <p
                className={
                  isPage
                    ? 'text-sm font-semibold uppercase tracking-wide text-muted-foreground'
                    : 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'
                }
              >
                {f.label}
              </p>
              <p
                className={
                  isPage
                    ? 'whitespace-pre-wrap break-words text-base leading-8 text-foreground'
                    : 'whitespace-pre-wrap break-words text-xs text-foreground'
                }
              >
                {f.value}
              </p>
            </div>
          ))}
      </div>

      {/* Same actions as a Feed entry: Report issue emails the team (needs only the
          diagnosis), Forward posts the report into a chosen conversation. */}
      <DiagnosisActionButtons
        suggestedConversationId={conversationId}
        busy={reporting}
        error={reportError}
        showDismiss={false}
        canReport={!!diagnosisId}
        onDismiss={() => onActionDone?.()}
        onReportIssue={() => void handleReportIssue()}
        onForward={(targetConversationId) => void handleForward(targetConversationId)}
      />
    </div>
  );
}
