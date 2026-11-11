import { useCallback, useEffect, useState } from 'react';
import { type HelpRequestDiagnosis, helpRequestDiagnosis } from '@sdk';

/** A help request's diagnosis state (`help-request-diagnosis`), read on mount and — while the diagnosis still
 *  runs — again every few seconds until it lands. `reload` reads it now (after Report it). One reader for
 *  every surface that shows it: the diagnosis message's actions and the warning it was started from. */
export function useHelpRequestDiagnosis(conversationId: string): [HelpRequestDiagnosis | null, () => void] {
  const [state, setState] = useState<HelpRequestDiagnosis | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    let timer: number | undefined;
    const load = () =>
      helpRequestDiagnosis(conversationId)
        .then((s) => {
          if (!live) return;
          setState(s);
          if (s.diagnosing) timer = window.setTimeout(load, 3000);
        })
        .catch(() => live && setState(null));
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [conversationId, tick]);
  return [state, reload];
}
