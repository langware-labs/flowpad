import { DiagnoseModal } from '@src/components/version-popover/diagnose-modal';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateTo } from '../commands';
import { useDiagnoseErrorStore } from './diagnose-error-store';

/**
 * "Diagnose this error / warning" — an error/warning toast, badge or warnings-popover row opens it via
 * `useDiagnoseErrorStore.open(detail, kind)`. It is THE Diagnose window, seeded with that detail: the
 * same people picker and "Send report once done" as the footer's, so a diagnosis started from an
 * error reaches someone too (this used to be a second window with no way to send at all).
 *
 * Mounted once in `main.tsx`, ABOVE the router (it must outlive a crashed route), so it runs the
 * window `inRouter={false}` and navigates by URL.
 */
export function DiagnoseErrorModal() {
  const detail = useDiagnoseErrorStore((s) => s.detail);
  const kind = useDiagnoseErrorStore((s) => s.kind);
  const close = useDiagnoseErrorStore((s) => s.close);

  return (
    <DiagnoseModal
      open={detail !== null}
      onClose={close}
      seed={detail !== null ? { detail, kind } : null}
      inRouter={false}
      onViewDiagnosis={({ diagnosisId }) => {
        close();
        navigateTo(DockPointer.forDiagnosis(diagnosisId).toUrl());
      }}
    />
  );
}
