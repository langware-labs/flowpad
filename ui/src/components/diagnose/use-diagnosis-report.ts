import { forwardDiagnosis, sendDiagnosisEmailReport } from '@sdk';
import { notify } from '@src/notifications';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useState } from 'react';

/**
 * The shared "act on a diagnosis" state machine behind `DiagnosisActionButtons`.
 * Every surface that renders those buttons — the Home-Feed card, the diagnosis
 * viewer/details, the diagnose modal — needs the same `busy`/`error`/`reported`
 * bookkeeping around `sendDiagnosisEmailReport` / `forwardDiagnosis`. Owning it
 * here (with the single success-toast wording) keeps the feedback contract from
 * drifting per caller. What stays caller-specific is the post-success tail —
 * close the modal, open the forwarded conversation, call `onActionDone` — so
 * `report`/`forward` return a success boolean and leave navigation to the caller.
 */
export function useDiagnosisReport(diagnosisId: string | null | undefined): {
  /** Email the diagnosis to the team; toasts + flips `reported` on success. */
  report: () => Promise<boolean>;
  /** Attach the diagnosis into a conversation; caller navigates on success. */
  forward: (conversationId: string) => Promise<boolean>;
  busy: boolean;
  reported: boolean;
  error?: string;
  /** Clear busy/reported/error — for surfaces reused across runs (the modal). */
  reset: () => void;
} {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const report = useCallback(async (): Promise<boolean> => {
    if (!diagnosisId) return false;
    setBusy(true);
    setError(undefined);
    try {
      await sendDiagnosisEmailReport(diagnosisId);
      setReported(true);
      notify.success({ title: t`Report sent to the Flowpad team` });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Failed to send report`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [diagnosisId, t]);

  const forward = useCallback(
    async (conversationId: string): Promise<boolean> => {
      if (!diagnosisId) return false;
      setBusy(true);
      setError(undefined);
      try {
        await forwardDiagnosis(conversationId, diagnosisId);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : t`Failed to send report`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [diagnosisId, t],
  );

  const reset = useCallback(() => {
    setBusy(false);
    setReported(false);
    setError(undefined);
  }, []);

  return { report, forward, busy, reported, error, reset };
}
