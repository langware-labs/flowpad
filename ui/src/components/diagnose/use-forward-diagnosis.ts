import { forwardDiagnosis } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useState } from 'react';

/** Attach a diagnosis to a conversation; the caller navigates when it answers true. */
export function useForwardDiagnosis(diagnosisId: string | null | undefined): {
  forward: (conversationId: string) => Promise<boolean>;
  busy: boolean;
  error?: string;
} {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

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

  return { forward, busy, error };
}
