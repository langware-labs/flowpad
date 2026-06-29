import { Trans } from '@lingui/react/macro';
import { TabbedTerminal } from '@src/components/terminal';
import { UnifiedTabStrip } from '@src/pages/flow-page/content-panel/unified-tab-strip';

/**
 * Developer sessions view (`/dev`) — shows EVERY terminal across all projects, so
 * the shared strip + body both run at `scope="all"` (the global `tab` list).
 */
export function SessionsView() {
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground"><Trans>Terminal Sessions</Trans></h2>
        <p className="mt-1 text-sm text-muted-foreground"><Trans>Manage your terminal sessions</Trans></p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <UnifiedTabStrip scope="all" />
        <div className="min-h-0 flex-1">
          <TabbedTerminal scope="all" />
        </div>
      </div>
    </div>
  );
}
