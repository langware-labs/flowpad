import { useLingui } from '@lingui/react/macro';
import { ArrowDownCircle } from 'lucide-react';
import { TopBarPill } from './TopBarPill';
import { openVersionPopover, useUpdateReady } from '@src/components/update-ready/update-ready';

/**
 * "Update ready" in the top bar while a downloaded, prepared and checked update waits to be applied (the footer's
 * version chip shows a dot for the same state). A click opens the version popover, where the update is applied.
 */
export function UpdateReadyIndicator() {
  const { t } = useLingui();
  const state = useUpdateReady();
  if (!state?.ready) return null;
  return (
    <TopBarPill
      testId="top-nav-update-ready"
      icon={<ArrowDownCircle className="h-3.5 w-3.5" />}
      label={t`Update ready`}
      title={t`An update is downloaded and ready to install`}
      onClick={() => openVersionPopover()}
    />
  );
}
