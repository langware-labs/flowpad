import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import { useCallback, useMemo } from 'react';
import { resolveAppHtml } from './app-resolver';
import { McpAppShell } from './McpAppShell';

interface AppParams {
  uname: string;
  routerPath: string;
  options: Record<string, string>;
}

function parseAppParams(pointer: string | undefined, options: Record<string, string> | undefined): AppParams | null {
  const parts = DockPointer.parseAppPointer(pointer);
  if (!parts) return null;
  return { uname: parts.uname, routerPath: parts.routerPath, options: options ?? {} };
}

export function AppHost() {
  const { currentDock, navigation } = useDockNavigation();
  const { resolvedTheme } = useTheme();

  const params = useMemo(
    () => parseAppParams(currentDock?.pointer, currentDock?.options),
    [currentDock?.pointer, currentDock?.options],
  );

  // hostContext drives ui/notifications/host-context-changed; @mcp-ui/client's
  // AppFrame waits for the bridge before applying, so we can safely pass it
  // even before init completes (no Not-connected race in v7.1.1).
  const hostContext = useMemo(
    () => ({
      theme: (resolvedTheme === 'light' ? 'light' : 'dark') as 'light' | 'dark',
      displayMode: 'inline' as const,
    }),
    [resolvedTheme],
  );

  // Guest sent a `navigate-app` message: push a new URL within this app's slot.
  const handleAppMessage = useCallback(
    async (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { kind?: string }).kind === 'navigate-app' && params) {
        const m = msg as { routerPath?: string; options?: Record<string, string> };
        navigation.openDock(DockPointer.forApp(params.uname, m.routerPath ?? '', m.options));
      }
      return {};
    },
    [navigation, params],
  );

  return (
    <McpAppShell
      params={params}
      loadHtml={(p) => resolveAppHtml(p.uname)}
      loadKey={params?.uname ?? null}
      toolName={params?.uname ?? ''}
      toolInput={{ routerPath: params?.routerPath, options: params?.options }}
      hostContext={hostContext}
      onMessage={handleAppMessage}
      invalidTitle={<Trans>Invalid App Path</Trans>}
      invalidHint={
        <>
          <p>
            <Trans>Expected format: /dock/apps/&lt;uname&gt;/&lt;routerPath&gt;?&lt;options&gt;</Trans>
          </p>
          <p className="mt-2">
            <Trans>Received pointer: {currentDock?.pointer || 'none'}</Trans>
          </p>
        </>
      }
      errorTitle={<Trans>Error Loading App</Trans>}
      loadingLabel={<Trans>Loading {params?.uname ?? ''}...</Trans>}
    />
  );
}
