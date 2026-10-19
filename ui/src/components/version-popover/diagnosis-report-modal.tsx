import { DiagnosisDetails } from '@src/components/diagnose/diagnosis-details';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { FlowpadDiagnosis, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans, useLingui } from '@lingui/react/macro';
import { Maximize2, Stethoscope } from 'lucide-react';
import { useMemo } from 'react';

interface DiagnosisReportModalProps {
  open: boolean;
  diagnosisId?: string;
  /** The support conversation — excluded from the Forward picker (present for a real issue). */
  conversationId?: string;
  onClose: () => void;
}

/**
 * The "View diagnosis" popup. Shows the recorded diagnosis (title / summary /
 * symptoms / root cause / fix) via the shared `DiagnosisDetails` body — Copy and,
 * for a real issue, the same Report/Forward buttons as a Feed entry. The expand
 * arrow promotes the popup into the full URL tab (`/dock/diagnosis/<id>`), closing
 * the overlay — the same content, now a first-class entity view.
 */
export function DiagnosisReportModal({ open, diagnosisId, conversationId, onClose }: DiagnosisReportModalProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const typeId = useMemo(() => (diagnosisId ? new TypeId(FlowpadDiagnosis.type, diagnosisId) : null), [diagnosisId]);
  const { data: diag } = useEntity<FlowpadDiagnosis>(typeId, { enabled: open && !!typeId });

  const handleExpand = () => {
    if (!diagnosisId) return;
    navigation.openDock(DockPointer.forDiagnosis(diagnosisId));
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2 pe-6">
            <Stethoscope className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{diag?.title || t`Diagnosis`}</span>
            <button
              type="button"
              onClick={handleExpand}
              disabled={!diagnosisId}
              title={t`Open as a tab`}
              aria-label={t`Open diagnosis as a tab`}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {diagnosisId && (
            <div className="max-h-[55vh] overflow-y-auto overflow-x-hidden pe-1">
              <DiagnosisDetails diagnosisId={diagnosisId} conversationId={conversationId} onActionDone={onClose} />
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Trans>Close</Trans>
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
