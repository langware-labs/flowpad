import { DesktopSurface } from '@src/components/quick-create/DesktopSurface';
import { Trans } from '@lingui/react/macro';

/**
 * DesktopPage — the full-page favorites desktop at /dock/desktop: the exact
 * same DesktopSurface the home MiniDesktop hosts, just with room to breathe
 * (large tiles, full viewport). URL-first sibling of the compact strip.
 */
export function DesktopPage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">
        <Trans>Desktop</Trans>
      </h1>
      <DesktopSurface size="large" />
    </div>
  );
}
