/**
 * ShowView unit tests
 *
 * jsdom can't drive the real iframe + sandbox proxy, so AppRenderer is mocked
 * and we assert that ShowView wires the right props and routes host-side
 * callbacks through Flowpad's SDK. AppRenderer's own protocol conformance is
 * the library's responsibility (covered upstream).
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRenderer, type AppRendererProps } from '@mcp-ui/client';

// vi.mock() factories are hoisted above var declarations; vi.hoisted() runs
// synchronously before imports, so refs created here are safe inside mocks.
const mocks = vi.hoisted(() => ({
  lastRendererProps: { current: null as AppRendererProps | null },
  downloadMock: vi.fn(),
  useDockNavigationMock: vi.fn(),
}));

vi.mock('@mcp-ui/client', () => ({
  AppRenderer: vi.fn((props: AppRendererProps) => {
    mocks.lastRendererProps.current = props;
    return <div data-testid="app-renderer-mock">mock</div>;
  }),
}));

// Partial mock — overrides `fsManager` + `VFSPath` but spreads the rest of
// the @sdk barrel so transitive importers (e.g. DockPointer's ViewType
// enum) still resolve. This is wider than ShowView strictly needs; any
// future @sdk module that adds an import-time side effect (network calls,
// singleton bootstrapping) will leak into this jsdom test. If that bites,
// reach for a per-symbol `vi.importActual` rather than widening further.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    fsManager: { download: (...args: unknown[]) => mocks.downloadMock(...args) },
    VFSPath: {
      parse: (raw: string) => {
        const stripped = raw.replace(/^(ui|vfs):\/\//, '');
        const idx = stripped.indexOf('/');
        if (idx < 0) {
          return { typeId: { type: 'unknown', id: stripped }, entitySubPath: '', type: 'unknown', id: stripped };
        }
        const left = stripped.slice(0, idx);
        const entitySubPath = stripped.slice(idx + 1);
        const dashIdx = left.indexOf('-');
        const type = left.slice(0, dashIdx);
        const id = left.slice(dashIdx + 1);
        return { typeId: { type, id }, entitySubPath, type, id };
      },
    },
  };
});

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => mocks.useDockNavigationMock(),
}));

vi.mock('@src/lib/mcp-sandbox', () => ({
  SANDBOX_URL: new URL('http://test.local/sandbox_proxy.html'),
}));

import { ShowView } from '@src/components/show-view/ShowView';

const VFS = 'compute_node-@local/.flow/system_skills/onboarding';

function setDockParams(params: { pointer?: string; options?: Record<string, string> } | null) {
  mocks.useDockNavigationMock.mockReturnValue({
    currentDock: params
      ? { pointer: params.pointer, options: params.options ?? {} }
      : { pointer: undefined, options: {} },
  });
}

// React render in jsdom double-invokes the component; the second call overwrites
// the side-effect ref with a stripped props object. Read from the recorded mock
// calls and pick the first one that actually carries the `html` prop.
function firstRendererCallWithHtml(): AppRendererProps | undefined {
  return vi
    .mocked(AppRenderer)
    .mock.calls.map((c) => c[0])
    .find((p): p is AppRendererProps => !!p && typeof p === 'object' && 'html' in p);
}

describe('ShowView', () => {
  beforeEach(() => {
    cleanup();
    mocks.lastRendererProps.current = null;
    mocks.downloadMock.mockReset();
    mocks.useDockNavigationMock.mockReset();
    vi.mocked(AppRenderer).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders invalid-path message when pointer is missing', () => {
    setDockParams(null);
    render(<ShowView />);
    expect(screen.getByText(/Invalid Show Path/i)).toBeInTheDocument();
  });

  it('fetches HTML via fsManager and renders AppRenderer with it', async () => {
    setDockParams({ pointer: VFS, options: { component: 'graph' } });
    mocks.downloadMock.mockResolvedValue('<html><body>hi</body></html>');

    render(<ShowView />);

    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());
    expect(mocks.downloadMock).toHaveBeenCalledWith(
      { type: 'compute_node', id: '@local' },
      '.flow/system_skills/onboarding/ui/graph.html',
    );
    expect(firstRendererCallWithHtml()?.html).toBe('<html><body>hi</body></html>');
    expect(screen.getByTestId('app-renderer-mock')).toBeInTheDocument();
  });

  it('passes toolName + toolInput from URL params', async () => {
    setDockParams({ pointer: VFS, options: { page: 'index', component: 'graph' } });
    mocks.downloadMock.mockResolvedValue('<html></html>');

    render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    expect(mocks.lastRendererProps.current?.toolName).toBe('graph');
    expect(mocks.lastRendererProps.current?.toolInput).toEqual({ entityVfs: VFS, page: 'index', component: 'graph' });
  });

  it('passes SANDBOX_URL + hostInfo defaults', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock.mockResolvedValue('<html></html>');

    render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    expect(mocks.lastRendererProps.current?.sandbox.url.toString()).toBe(
      'http://test.local/sandbox_proxy.html',
    );
    expect(mocks.lastRendererProps.current?.hostInfo).toEqual({ name: 'Flowpad', version: '1.0.0' });
  });

  it('shows error UI when HTML fetch fails', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock.mockRejectedValue(new Error('not found'));

    render(<ShowView />);

    await waitFor(() => expect(screen.getByText(/Error Loading Component/i)).toBeInTheDocument());
    expect(screen.getByText('not found')).toBeInTheDocument();
  });

  it('onCallTool returns isError instead of hanging when no host routing exists', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock.mockResolvedValue('<html></html>');

    render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    const result = await mocks.lastRendererProps.current!.onCallTool!(
      { name: 'ping', arguments: {} },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('ping') });
  });

  it('onReadResource routes ui:// URIs through fsManager and returns spec shape', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock
      .mockResolvedValueOnce('<html></html>')
      .mockResolvedValueOnce('file contents');

    render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    const result = await mocks.lastRendererProps.current!.onReadResource!(
      { uri: 'ui://compute_node-@local/some/file.txt' },
      {} as never,
    );

    expect(mocks.downloadMock).toHaveBeenLastCalledWith(
      { type: 'compute_node', id: '@local' },
      'some/file.txt',
    );
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: 'ui://compute_node-@local/some/file.txt',
      mimeType: 'text/plain',
      text: 'file contents',
    });
  });

  it('onOpenLink opens the URL in a new tab', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock.mockResolvedValue('<html></html>');
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    await mocks.lastRendererProps.current!.onOpenLink!({ url: 'https://example.com' }, {} as never);
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('onMessage acknowledges with empty result (host observation point)', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock.mockResolvedValue('<html></html>');

    render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    const result = await mocks.lastRendererProps.current!.onMessage!(
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {} as never,
    );
    expect(result).toEqual({});
  });

  it('onError surfaces the message in the UI', async () => {
    setDockParams({ pointer: VFS });
    mocks.downloadMock.mockResolvedValue('<html></html>');

    const { rerender } = render(<ShowView />);
    await waitFor(() => expect(mocks.lastRendererProps.current).not.toBeNull());

    mocks.lastRendererProps.current!.onError!(new Error('bridge failure'));
    rerender(<ShowView />);
    await waitFor(() => expect(screen.getByText(/Error Loading Component/i)).toBeInTheDocument());
    expect(screen.getByText('bridge failure')).toBeInTheDocument();
  });
});
