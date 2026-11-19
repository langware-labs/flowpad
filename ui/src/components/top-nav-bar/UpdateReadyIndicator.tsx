import { useLingui } from '@lingui/react/macro';
import { ArrowDownCircle } from 'lucide-react';
import { openVersionPopover, useUpdateReady } from '@src/components/update-ready/update-ready';

/**
 * "Update ready" in the top bar while a downloaded, prepared and checked update waits to be applied (the footer's
 * version chip shows a dot for the same state). A click opens the version popover, where the update is applied.
 */
export function UpdateReadyIndicator() {
  const { t } = useLingui();
  const state = useUpdateReady();
  if (!state?.ready) return null;
  const label = t`Update ready`;
  return (
    <button
      type="button"
      data-testid="top-nav-update-ready"
      onClick={() => openVersionPopover()}
      title={t`An update is downloaded and ready to install`}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <ArrowDownCircle className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  );
}
