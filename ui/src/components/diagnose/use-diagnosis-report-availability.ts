import { usePrivacyMode } from '@src/hooks/use-privacy-mode';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';

function readNavigatorOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/**
 * "Report issue" sends diagnosis content to Flowpad support. It is intentionally
 * not gated on cloud login or the hub websocket, but it should be unavailable
 * when the instance is in Local privacy mode or the browser is offline.
 */
export function useDiagnosisReportAvailability(): {
  canReport: boolean;
  disabledReason?: string;
} {
  const { t } = useLingui();
  const { isLocal } = usePrivacyMode();
  const [online, setOnline] = useState(readNavigatorOnline);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setOnline(readNavigatorOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return useMemo(() => {
    if (isLocal) {
      return {
        canReport: false,
        disabledReason: t`Reporting is disabled in Local data privacy mode`,
      };
    }
    if (!online) {
      return {
        canReport: false,
        disabledReason: t`Reporting needs an internet connection`,
      };
    }
    return { canReport: true };
  }, [isLocal, online, t]);
}
