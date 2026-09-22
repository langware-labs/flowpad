/**
 * An MCP App shown beside a process can use the Flowpad SDK.
 *
 * Two things make that possible, and both are McpAppPreview's to supply:
 *   - a sandbox CSP that lets the page load `/sdk/flowpad-sdk.js` and talk to the
 *     backend (AppFrame applies it to the proxy url AND the resource-ready meta);
 *   - `__FLOWPAD_API_URL__` / `__FLOWPAD_PROCESS_ID__` set before the page's own
 *     scripts run.
 * jsdom cannot run the sandbox, so AppRenderer is captured and its props checked;
 * the real browser path is `ui/tests/e2e/page-sdk-bridge`.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const API = 'http://localhost:6007';
const PID = '3f2a1b4c-0000-4000-8000-0000000000aa';

const mocks = vi.hoisted(() => ({ props: [] as any[] }));

vi.mock('@mcp-ui/client', () => ({
  AppRenderer: (props: any) => {
    mocks.props.push(props);
    return null;
  },
}));
vi.mock('@sdk/config/index', () => ({
  sdkConfig: { apiUrl: 'http://localhost:6007', wsUrl: 'ws://localhost:6007/api/v1/connect/ws' },
}));
vi.mock('@src/lib/mcp-sandbox', () => ({ SANDBOX_URL: new URL('http://localhost:6007/mcp-sandbox/sandbox_proxy.html') }));
vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({ computeNode: { typeId: { toString: () => 'compute_node-@local' } } }),
}));
vi.mock('@src/lib/mcp-app-resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/lib/mcp-app-resources')>();
  return {
    ...actual,
    readFlowpadLocalResource: async (uri: string) => ({
      contents: [{ uri, mimeType: actual.MCP_APP_MIME_TYPE, text: '<html><head><script>page()</script></head></html>' }],
    }),
  };
});

import { McpAppPreview } from '@src/components/mcp-app-preview/McpAppPreview';
import { injectHeadScript, pageSdkPrelude } from '@src/lib/mcp-app-resources';

const last = () => mocks.props[mocks.props.length - 1];

describe('McpAppPreview gives the page the SDK', () => {
  afterEach(() => {
    mocks.props.length = 0;
    cleanup();
  });

  it('opens the sandbox CSP to the backend, for HTTP, WebSocket and the SDK script', () => {
    render(<McpAppPreview path="/tmp/probe.mcp.html" process={{ id: PID } as any} />);

    expect(last().sandbox.csp).toEqual({
      connectDomains: [API, 'ws://localhost:6007'],
      resourceDomains: [API],
    });
  });

  it('keeps the sandbox config stable across renders, so the page is not reloaded', () => {
    const { rerender } = render(<McpAppPreview path="/tmp/probe.mcp.html" process={{ id: PID } as any} />);
    const first = last().sandbox;
    rerender(<McpAppPreview path="/tmp/probe.mcp.html" process={{ id: PID } as any} />);
    expect(last().sandbox).toBe(first);
  });

  it("sets the API origin and the process id before the page's own scripts", async () => {
    render(<McpAppPreview path="/tmp/probe.mcp.html" process={{ id: PID } as any} />);

    await waitFor(() => expect(last()).toBeTruthy());
    const result = await last().onReadResource({ uri: 'ui://flowpad-local/tmp/probe.mcp.html' });
    const head = result.contents[0].text.split('<script>page()')[0];
    expect(head).toContain(`globalThis.__FLOWPAD_API_URL__="${API}"`);
    expect(head).toContain(`globalThis.__FLOWPAD_PROCESS_ID__="${PID}"`);
  });
});

describe('page SDK prelude', () => {
  it('omits the process id when there is none', () => {
    expect(pageSdkPrelude(API, null)).not.toContain('__FLOWPAD_PROCESS_ID__');
  });

  it('cannot be closed early by a value', () => {
    expect(pageSdkPrelude('http://x/</script><script>evil()', PID)).not.toMatch(/<\/script><script>evil/);
  });

  it('injects once, after <head>', () => {
    const snippet = pageSdkPrelude(API, PID);
    const once = injectHeadScript('<html><head lang="en"><title>t</title></head></html>', snippet);
    expect(once.indexOf(snippet)).toBe('<html><head lang="en">'.length);
    expect(injectHeadScript(once, snippet)).toBe(once);
  });
});
