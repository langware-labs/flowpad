/**
 * Which surface `WebappDisplay` puts on screen for each verdict, and — the part
 * that costs real money if it is wrong — when it spends tokens on a repair.
 *
 * `PersistentIframe` is stubbed here on purpose: jsdom cannot load a real
 * cross-origin frame, and the frame's own events are not a signal this component
 * consumes anyway (a refused navigation still fires `onload`, which is why the
 * verdict comes from diagnostics instead). What matters is the branch chosen and
 * the props handed down.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebappVerdict } from '@src/components/webapp-display/classify';

const mocks = vi.hoisted(() => ({
  diagnostics: {
    current: null as (WebappVerdict & { health: string; probe: unknown; reloadNonce: number }) | null,
  },
  fixStart: vi.fn(),
  fixRunning: { current: false },
  autoAttempted: { current: false },
  iframeProps: { current: null as Record<string, unknown> | null },
}));

vi.mock('@src/components/persistent-iframe', async () => {
  const { forwardRef } = await import('react');
  return {
    __esModule: true,
    // forwardRef because the real component is one and the display passes a ref
    // through to it; a plain function stub would warn on every render.
    default: forwardRef((props: Record<string, unknown>, _ref) => {
      mocks.iframeProps.current = props;
      return <div data-testid="stub-iframe" />;
    }),
  };
});

vi.mock('@src/components/webapp-display/useWebappDiagnostics', () => ({
  useWebappDiagnostics: () => ({
    ...mocks.diagnostics.current,
    refresh: vi.fn(),
  }),
}));

vi.mock('@src/components/webapp-display/useWebappFix', () => ({
  useWebappFix: () => ({
    running: mocks.fixRunning.current,
    toolCount: 0,
    start: mocks.fixStart,
    autoAttempted: mocks.autoAttempted.current,
  }),
}));

const { WebappDisplay } = await import('@src/components/webapp-display/WebappDisplay');

function setVerdict(verdict: Partial<WebappVerdict>) {
  mocks.diagnostics.current = {
    severity: 'ok',
    code: 'ok',
    detail: [],
    health: 'up',
    probe: {},
    reloadNonce: 0,
    ...verdict,
  } as never;
}

function renderDisplay() {
  return render(
    <WebappDisplay processId="p1" src="http://localhost:6001/get-host?port=4173" port="4173" testId="frame" />,
  );
}

describe('WebappDisplay', () => {
  beforeEach(() => {
    mocks.fixStart.mockClear();
    mocks.fixRunning.current = false;
    mocks.autoAttempted.current = false;
    mocks.iframeProps.current = null;
  });

  afterEach(() => {
    // The unit tier has no automatic RTL cleanup, so mounted trees would
    // otherwise pile up and every getByTestId would match several nodes.
    cleanup();
    vi.clearAllMocks();
  });

  it('gets out of the way when the app is healthy', () => {
    setVerdict({ severity: 'ok', code: 'ok' });
    renderDisplay();
    expect(screen.getByTestId('stub-iframe')).toBeTruthy();
    expect(screen.queryByTestId('webapp-debug-panel')).toBeNull();
    expect(screen.queryByTestId('webapp-error-banner')).toBeNull();
  });

  it('replaces the frame with the debug panel when there is nothing to look at', () => {
    setVerdict({ severity: 'fatal', code: 'not_running' });
    renderDisplay();
    expect(screen.getByTestId('webapp-debug-panel')).toBeTruthy();
    // The frame must be GONE, not merely covered — this is the case where the
    // user previously got a blank pane with a broken-image icon.
    expect(screen.queryByTestId('stub-iframe')).toBeNull();
  });

  it('states the problem in the user’s terms, not the probe’s', () => {
    setVerdict({ severity: 'fatal', code: 'not_running', detail: ['nav: connection_refused'] });
    renderDisplay();
    const headline = screen.getByTestId('webapp-error-headline').textContent ?? '';
    expect(headline).toContain("isn't running");
    // The raw evidence is present for the agent, but not shown up front.
    expect(headline).not.toContain('connection_refused');
    expect(screen.queryByTestId('webapp-detail-body')).toBeNull();
  });

  it('keeps the app on screen and warns when it still works', () => {
    setVerdict({ severity: 'degraded', code: 'console_errors' });
    renderDisplay();
    expect(screen.getByTestId('webapp-error-banner')).toBeTruthy();
    expect(screen.getByTestId('stub-iframe')).toBeTruthy();
  });

  it('shows no error surface at all while the app is still starting', () => {
    setVerdict({ severity: 'unknown', code: 'starting', probe: null });
    renderDisplay();
    expect(screen.queryByTestId('webapp-debug-panel')).toBeNull();
    expect(screen.queryByTestId('webapp-error-banner')).toBeNull();
    expect(screen.getByTestId('webapp-starting')).toBeTruthy();
  });

  it('repairs a fatal failure without being asked', async () => {
    setVerdict({ severity: 'fatal', code: 'not_running' });
    renderDisplay();
    await waitFor(() => expect(mocks.fixStart).toHaveBeenCalledTimes(1));
  });

  it('never auto-repairs a merely degraded app', async () => {
    setVerdict({ severity: 'degraded', code: 'console_errors' });
    renderDisplay();
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.fixStart).not.toHaveBeenCalled();
  });

  it('does not start a second automatic repair for the same failure', async () => {
    // The vicious loop this guards: the agent restarts the dev server, the port
    // blinks, that reads as a fresh fatal, and another paid run begins.
    mocks.autoAttempted.current = true;
    setVerdict({ severity: 'fatal', code: 'not_running' });
    renderDisplay();
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.fixStart).not.toHaveBeenCalled();
  });

  it('does not stack a repair on top of one already running', async () => {
    mocks.fixRunning.current = true;
    setVerdict({ severity: 'fatal', code: 'not_running' });
    renderDisplay();
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.fixStart).not.toHaveBeenCalled();
  });

  it('forces a real reload when the app comes back from the dead', () => {
    // The registry parks dead frames rather than destroying them, so without a
    // changing cacheKey a recovered app re-reveals Chrome's error page.
    setVerdict({ severity: 'ok', code: 'ok', reloadNonce: 3 });
    renderDisplay();
    expect(mocks.iframeProps.current?.cacheKey).toBe(3);
  });
});
