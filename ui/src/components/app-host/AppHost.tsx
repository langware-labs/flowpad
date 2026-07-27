import { AppRenderer } from '@mcp-ui/client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SANDBOX_URL } from '@src/lib/mcp-sandbox';
import { readVfsResource } from '@src/lib/mcp-app-resources';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveAppHtml } from './app-resolver';
import { isInternalDockUrl, parseDockUrlToPointer } from './dock-url-helpers';
import '@src/lib/mcp-host.css';

const HOST_INFO = { name: 'Flowpad', version: '1.0.0' } as const;

interface AppParams {
  uname: string;
  routerPath: string;
  options: Record<string, string>;
}

function parseAppParams(
  pointer: string | undefined,
  options: Record<string, string> | undefined,
): AppParams | null {
  const parts = DockPointer.parseAppPointer(pointer);
  if (!parts) return null;
  return { uname: parts.uname, routerPath: parts.routerPath, options: options ?? {} };
}

async function handleCallTool(params: { name: string }): Promise<CallToolResult> {
  return {
    content: [{ type: 'text', text: `Tool '${params.name}' is not yet routed through the Flowpad SDK.` }],
    isError: true,
  };
}

async function handleReadResource(params: { uri: string }) {
  return readVfsResource(params.uri);
}

export function AppHost() {
  const { currentDock, navigation } = useDockNavigation();
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(
    () => parseAppParams(currentDock?.pointer, currentDock?.options),
    [currentDock?.pointer, currentDock?.options],
  );

  // hostContext drives ui/notifications/host-context-changed; @mcp-ui/client's
  // AppFrame waits for the bridge before applying, so we can safely pass it
  // even before init completes (no Not-connected race in v7.1.1).
  const hostContext = useMemo(
    () => ({ theme: (resolvedTheme === 'light' ? 'light' : 'dark') as 'light' | 'dark', displayMode: 'inline' as const }),
    [resolvedTheme],
  );

  const handleError = useCallback((err: Error) => setError(err.message), []);

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

  // Guest asked to open a link: internal /dock/ URLs flow through navigation; others get a new tab.
  const handleOpenLink = useCallback(
    async ({ url }: { url: string }) => {
      if (isInternalDockUrl(url)) {
        const pointer = parseDockUrlToPointer(url);
        if (pointer) {
          navigation.openDock(pointer);
          return {};
        }
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      return {};
    },
    [navigation],
  );

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    setError(null);
    setHtml(null);

    resolveAppHtml(params.uname).then(
      (h) => {
        if (!cancelled) setHtml(h);
      },
      (e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [params?.uname]);

  if (!params) {
    return (
      <div className="h-full w-full p-8 font-mono">
        <h2 className="mb-4 text-xl font-bold"><Trans>Invalid App Path</Trans></h2>
        <p><Trans>Expected format: /dock/apps/&lt;uname&gt;/&lt;routerPath&gt;?&lt;options&gt;</Trans></p>
        <p className="mt-2"><Trans>Received pointer: {currentDock?.pointer || 'none'}</Trans></p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full p-8 font-mono text-red-600">
        <h2 className="mb-4 text-xl font-bold"><Trans>Error Loading App</Trans></h2>
        <p>{error}</p>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-gray-500"><Trans>Loading {params.uname}...</Trans></p>
      </div>
    );
  }

  return (
    <div className="flowpad-app-host">
      <AppRenderer
        html={html}
        toolName={params.uname}
        toolInput={{ routerPath: params.routerPath, options: params.options }}
        sandbox={{ url: SANDBOX_URL }}
        hostInfo={HOST_INFO}
        hostContext={hostContext}
        onCallTool={handleCallTool}
        onReadResource={handleReadResource}
        onMessage={handleAppMessage}
        onOpenLink={handleOpenLink}
        onError={handleError}
      />
    </div>
  );
}
