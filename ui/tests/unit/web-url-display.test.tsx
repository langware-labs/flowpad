/**
 * The warning over an external page: when it appears, what it says, and that
 * "Open in browser" leaves the app.
 *
 * `PersistentIframe` is stubbed because jsdom cannot load a cross-origin frame,
 * and the frame's events are not a signal anyway (a refused frame fires `onload`).
 * `apiClient` is stubbed at the transport edge; the header rules themselves are
 * pinned against a real server in `tests/unit/test_webpage_status.py`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebpageStatus } from '@src/components/web-url-display/classify';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('@sdk/client', () => ({ __esModule: true, default: { post: mocks.post } }));
vi.mock('@src/lib/open-external', () => ({ openExternal: mocks.openExternal }));
vi.mock('@src/components/persistent-iframe', async () => {
  const { forwardRef } = await import('react');
  return {
    __esModule: true,
    default: forwardRef((_props: Record<string, unknown>, _ref) => <div data-testid="stub-iframe" />),
  };
});

const { WebUrlDisplay } = await import('@src/components/web-url-display/WebUrlDisplay');
const { classifyWebpageStatus } = await import('@src/components/web-url-display/classify');
const { clearWebpageStatusCache } = await import('@src/components/web-url-display/useWebpageStatus');

const URL_ = 'https://github.com/langware-labs/flowpad-hub/pull/1138';

function status(patch: Partial<WebpageStatus>): WebpageStatus {
  return {
    url: URL_,
    reachable: true,
    http_status: 200,
    nav_error: null,
    frame_blocked: false,
    frame_block_reason: null,
    ...patch,
  };
}

describe('classifyWebpageStatus', () => {
  it('warns on a refused frame even when the backend got a 404', () => {
    expect(classifyWebpageStatus(status({ http_status: 404, frame_blocked: true }))).toBe('frame_blocked');
  });

  it('never warns on an HTTP status alone — the backend has no cookies', () => {
    expect(classifyWebpageStatus(status({ http_status: 404 }))).toBeNull();
    expect(classifyWebpageStatus(status({ http_status: 403 }))).toBeNull();
  });

  it('warns when nothing answers', () => {
    expect(classifyWebpageStatus(status({ reachable: false, nav_error: 'dns_failure' }))).toBe('unreachable');
    expect(classifyWebpageStatus(status({ reachable: false, nav_error: 'connection_refused' }))).toBe('unreachable');
  });

  it('does not blame the page for a check that broke', () => {
    expect(classifyWebpageStatus(status({ reachable: false, nav_error: 'probe_error' }))).toBeNull();
    expect(classifyWebpageStatus(null)).toBeNull();
  });
});

describe('WebUrlDisplay', () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.openExternal.mockReset();
    clearWebpageStatusCache();
  });

  afterEach(() => {
    cleanup();
  });

  it('checks the page with this app as the embedder', async () => {
    mocks.post.mockResolvedValue(status({}));
    render(<WebUrlDisplay url={URL_} />);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/web/status', {
      url: URL_,
      embedder_origin: window.location.origin,
    });
  });

  it('shows the page with no warning when it can be framed', async () => {
    mocks.post.mockResolvedValue(status({}));
    render(<WebUrlDisplay url={URL_} />);
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('stub-iframe')).toBeTruthy();
    expect(screen.queryByTestId('web-url-warning')).toBeNull();
  });

  it('puts a warning over a refused frame, and Open in browser leaves the app', async () => {
    mocks.post.mockResolvedValue(
      status({ http_status: 404, frame_blocked: true, frame_block_reason: 'x-frame-options: DENY' }),
    );
    render(<WebUrlDisplay url={URL_} />);
    const warning = await screen.findByTestId('web-url-warning');
    expect(warning.getAttribute('data-issue')).toBe('frame_blocked');
    expect(warning.textContent).toContain('github.com');
    expect(warning.textContent).toContain('x-frame-options: DENY');
    // Over the frame, not instead of it: the check can be wrong.
    expect(screen.getByTestId('stub-iframe')).toBeTruthy();
    expect(screen.queryByTestId('web-url-retry')).toBeNull();

    fireEvent.click(screen.getByTestId('web-url-open-in-browser'));
    expect(mocks.openExternal).toHaveBeenCalledWith(URL_);
  });

  it('does not fetch the site again when the display remounts', async () => {
    // A tab switch remounts the viewer; the parked frame does not reload, and
    // neither should the check.
    mocks.post.mockResolvedValue(status({ frame_blocked: true, frame_block_reason: 'x-frame-options: DENY' }));
    const first = render(<WebUrlDisplay url={URL_} />);
    await screen.findByTestId('web-url-warning');
    first.unmount();

    render(<WebUrlDisplay url={URL_} />);
    await screen.findByTestId('web-url-warning');
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('offers a retry for an unreachable page, which checks again', async () => {
    mocks.post.mockResolvedValueOnce(status({ reachable: false, http_status: null, nav_error: 'dns_failure' }));
    render(<WebUrlDisplay url={URL_} />);
    expect((await screen.findByTestId('web-url-warning')).getAttribute('data-issue')).toBe('unreachable');

    mocks.post.mockResolvedValueOnce(status({}));
    fireEvent.click(screen.getByTestId('web-url-retry'));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('web-url-warning')).toBeNull());
  });

  it('shows the page untouched when the check itself fails, and tries again next mount', async () => {
    mocks.post.mockRejectedValue(new Error('backend down'));
    const first = render(<WebUrlDisplay url={URL_} />);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('web-url-warning')).toBeNull();
    first.unmount();

    render(<WebUrlDisplay url={URL_} />);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  });
});
