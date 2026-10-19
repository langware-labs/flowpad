import { AppRenderer } from '@mcp-ui/client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SANDBOX_URL } from '@src/lib/mcp-sandbox';
import { readVfsResource } from '@src/lib/mcp-app-resources';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { openGuestLink } from './dock-url-helpers';
import '@src/lib/mcp-host.css';

const HOST_INFO = { name: 'Flowpad', version: '1.0.0' } as const;

/**
 * Tool calls are not routed through the SDK yet — every guest `tools/call`
 * comes back as an error result rather than silently hanging the bridge.
 */
async function handleCallTool(params: { name: string }): Promise<CallToolResult> {
  return {
    content: [{ type: 'text', text: `Tool '${params.name}' is not yet routed through the Flowpad SDK.` }],
    isError: true,
  };
}

async function handleReadResource(params: { uri: string }) {
  return readVfsResource(params.uri);
}

async function handleNoopMessage() {
  return {};
}

export interface McpAppShellProps<P> {
  /**
   * Parsed route params, or `null` when the URL doesn't describe a loadable
   * app — that's what renders `invalidTitle` / `invalidHint`.
   */
  params: P | null;
  /** Fetches the guest HTML for the current params. */
  loadHtml: (params: P) => Promise<string>;
  /**
   * Effect dependency for the load. Each host scopes reloading differently
   * (ShowView on the whole params object, AppHost on `uname` alone), so the
   * key is supplied rather than derived.
   */
  loadKey: string | P | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  hostContext?: { theme: 'light' | 'dark'; displayMode: 'inline' };
  /** Guest `postMessage` handler; defaults to a no-op ack. */
  onMessage?: (msg: unknown) => Promise<Record<string, never>>;
  invalidTitle: ReactNode;
  invalidHint: ReactNode;
  loadingLabel: ReactNode;
  errorTitle: ReactNode;
}

/**
 * The MCP guest-hosting shell shared by `/dock/show/…` (ShowView) and
 * `/dock/apps/…` (AppHost): html + error state, the cancellable load effect,
 * link routing through `openGuestLink`, the tool/resource stubs, the three
 * pre-render fallbacks, and the `<AppRenderer>` itself.
 *
 * Each host keeps only what actually differs — how it parses its pointer, how
 * it fetches HTML, and its copy.
 */
export function McpAppShell<P>({
  params,
  loadHtml,
  loadKey,
  toolName,
  toolInput,
  hostContext,
  onMessage,
  invalidTitle,
  invalidHint,
  loadingLabel,
  errorTitle,
}: McpAppShellProps<P>) {
  const { navigation } = useDockNavigation();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback((err: Error) => setError(err.message), []);

  const handleOpenLink = useCallback(
    async ({ url }: { url: string }) => {
      openGuestLink(url, navigation);
      return {};
    },
    [navigation],
  );

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    setError(null);
    setHtml(null);

    loadHtml(params).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  if (!params) {
    return (
      <div className="h-full w-full p-8 font-mono">
        <h2 className="mb-4 text-xl font-bold">{invalidTitle}</h2>
        {invalidHint}
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full p-8 font-mono text-red-600">
        <h2 className="mb-4 text-xl font-bold">{errorTitle}</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-gray-500">{loadingLabel}</p>
      </div>
    );
  }

  return (
    <div className="flowpad-app-host">
      <AppRenderer
        html={html}
        toolName={toolName}
        toolInput={toolInput}
        sandbox={{ url: SANDBOX_URL }}
        hostInfo={HOST_INFO}
        hostContext={hostContext}
        onCallTool={handleCallTool}
        onReadResource={handleReadResource}
        onMessage={onMessage ?? handleNoopMessage}
        onOpenLink={handleOpenLink}
        onError={handleError}
      />
    </div>
  );
}
