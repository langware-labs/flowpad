import { DiagnosisActionButtons } from '@src/components/diagnose/diagnosis-action-buttons';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { FlowpadDiagnosis, sendDiagnosisReport } from '@sdk';
import { Loader2, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface DiagnosisReportModalProps {
  open: boolean;
  diagnosisId?: string;
  /** The suggested support conversation for the report buttons (present for a real issue). */
  conversationId?: string;
  onClose: () => void;
}

interface Field {
  label: string;
  value?: string;
}

/**
 * The "View diagnosis" popup, opened from the finished-diagnose modal in place of
 * it. Shows the full recorded diagnosis (title / summary / symptoms / root cause /
 * fix) and — for a real issue — the same report buttons as a Feed entry, wired to
 * the diagnosis's support conversation.
 */
export function DiagnosisReportModal({
  open,
  diagnosisId,
  conversationId,
  onClose,
}: DiagnosisReportModalProps) {
  const [diag, setDiag] = useState<FlowpadDiagnosis | null>(null);
  const [loading, setLoading] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open || !diagnosisId) return;
    let cancelled = false;
    setLoading(true);
    setReportError(undefined);
    void FlowpadDiagnosis.getById<FlowpadDiagnosis>(diagnosisId)
      .then((d) => {
        if (!cancelled) setDiag(d ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, diagnosisId]);

  const handleReport = useCallback(
    async (targetConversationId: string) => {
      setReporting(true);
      setReportError(undefined);
      try {
        await sendDiagnosisReport(targetConversationId, diag?.summary || diag?.title || '');
        onClose();
      } catch (e) {
        setReportError(e instanceof Error ? e.message : 'Failed to send report');
      } finally {
        setReporting(false);
      }
    },
    [diag, onClose],
  );

  const fields: Field[] = [
    { label: 'Summary', value: diag?.summary },
    { label: 'Symptoms', value: diag?.symptoms },
    { label: 'Root cause', value: diag?.rca },
    { label: 'Fix', value: diag?.fix },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4" />
            {diag?.title || 'Diagnosis'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading diagnosis…</span>
            </div>
          ) : (
            <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
              {fields
                .filter((f) => f.value)
                .map((f) => (
                  <div key={f.label}>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {f.label}
                    </p>
                    <p className="whitespace-pre-wrap text-xs text-foreground">{f.value}</p>
                  </div>
                ))}
            </div>
          )}

          {/* Same report buttons as a Feed entry — only when there's an issue to report. */}
          {conversationId && (
            <DiagnosisActionButtons
              suggestedConversationId={conversationId}
              busy={reporting}
              error={reportError}
              onDismiss={onClose}
              onReport={(targetConversationId) => void handleReport(targetConversationId)}
            />
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Close
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
