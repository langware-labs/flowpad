/**
 * Tests for ``TerminalRuntimeErrorBanner`` — the recovery surface that
 * the shell-dock loader populates on soft ProcessLoadError. Each kind
 * must render its own copy + a clickable primary action.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalRuntimeError, TerminalRuntimeErrorKind } from '@sdk';
import { TerminalRuntimeErrorBanner } from '@src/components/terminal/interactive-terminal/TerminalRuntimeErrorBanner';

const PROCESS_ID = 'aaaa1111-2222-4333-8444-555555555555';

// Reactive snapshot from ``useContext`` — we drive it from the test.
const mockSnapshot: { terminalRuntimeError: TerminalRuntimeError | null } = {
  terminalRuntimeError: null,
};

vi.mock('@src/hooks/useContext', () => ({
  useContext: () => mockSnapshot,
}));

vi.mock('@sdk', async () => {
  // Keep real Project / TypeId exports; just stub the dataContext mutators.
  const real = (await vi.importActual<typeof import('@sdk')>('@sdk'));
  return {
    ...real,
    dataContext: {
      ...real.dataContext,
      setTerminalRuntimeError: vi.fn(),
      setContextEntityTypeId: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function setError(kind: TerminalRuntimeErrorKind): void {
  mockSnapshot.terminalRuntimeError = { kind, processId: PROCESS_ID, shellId: null };
}

describe('TerminalRuntimeErrorBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    mockSnapshot.terminalRuntimeError = null;
  });

  it('renders nothing when terminalRuntimeError is null', () => {
    const { container } = render(<TerminalRuntimeErrorBanner />);
    expect(container.firstChild).toBeNull();
  });

  it.each<[TerminalRuntimeErrorKind, RegExp, RegExp]>([
    ['runtime_terminated', /process has stopped/i, /restart/i],
    ['pty_attach_failed', /PTY disconnected/i, /reconnect/i],
    ['shell_entity_missing', /shell record is missing/i, /restart/i],
    ['project_missing', /project/i, /recover project/i],
    ['network_error', /couldn.?t reach the backend/i, /retry/i],
  ])('renders the right copy + action button for kind=%s', (kind, titleMatcher, actionMatcher) => {
    setError(kind);
    render(<TerminalRuntimeErrorBanner />);
    const banner = screen.getByTestId('terminal-runtime-error-banner');
    expect(banner.getAttribute('data-error-kind')).toBe(kind);
    expect(banner.textContent).toMatch(titleMatcher);
    const action = screen.getByTestId('terminal-runtime-error-banner-action');
    expect(action.textContent).toMatch(actionMatcher);
  });

  it('Dismiss button calls dataContext.setTerminalRuntimeError(null)', async () => {
    setError('pty_attach_failed');
    const { dataContext } = await import('@sdk');
    render(<TerminalRuntimeErrorBanner />);
    fireEvent.click(screen.getByTestId('terminal-runtime-error-banner-dismiss'));
    expect(dataContext.setTerminalRuntimeError).toHaveBeenCalledWith(null);
  });
});
