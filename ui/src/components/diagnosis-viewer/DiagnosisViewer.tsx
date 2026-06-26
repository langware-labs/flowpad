import { useMemo } from 'react';
import { FlowpadDiagnosis, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DiagnosisDetails } from '@src/components/diagnose/diagnosis-details';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

interface DiagnosisViewerProps {
  /** The FlowpadDiagnosis entity id (dock pointer = /dock/diagnosis/<id>). */
  pointer?: string;
}

/**
 * Routed full-tab viewer for a single FlowpadDiagnosis (`/dock/diagnosis/<id>`).
 * The URL-first counterpart of the popup: it renders the same `DiagnosisDetails`
 * body inside page chrome (type icon + title). Reached by clicking the expand
 * arrow in the popup, or by navigating to the URL directly.
 */
export function DiagnosisViewer({ pointer }: DiagnosisViewerProps) {
  const typeId = useMemo(
    () => (pointer ? new TypeId(FlowpadDiagnosis.type, pointer) : null),
    [pointer],
  );
  const { data: diag } = useEntity<FlowpadDiagnosis>(typeId, { enabled: !!typeId });
  const Icon = iconForType(FlowpadDiagnosis.type);

  if (!pointer) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No diagnosis selected.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <div className="mb-8 flex items-center gap-3 border-b pb-5">
          <Icon className="h-7 w-7 shrink-0 text-muted-foreground" />
          <h1 className="text-2xl font-semibold leading-tight">
            {diag?.title || diag?.name || 'Diagnosis'}
          </h1>
        </div>
        <DiagnosisDetails diagnosisId={pointer} variant="page" />
      </div>
    </div>
  );
}
