import { useLingui } from '@lingui/react/macro';
import { RefreshCw } from 'lucide-react';
import { TopBarPill } from './TopBarPill';
import { useStalePage } from '@src/components/update-ready/stale-page';

/**
 * "New version" in the top bar once Flowpad was updated under this open page: the page still runs the previous
 * UI. A click reloads it onto the new one.
 */
export function StalePageIndicator() {
  const { t } = useLingui();
  if (!useStalePage()) return null;
  return (
    <TopBarPill
      testId="top-nav-stale-page"
      icon={<RefreshCw className="h-3.5 w-3.5" />}
      label={t`New version — reload`}
      title={t`Flowpad was updated. Reload this page to use the new version.`}
      onClick={() => window.location.reload()}
    />
  );
}
