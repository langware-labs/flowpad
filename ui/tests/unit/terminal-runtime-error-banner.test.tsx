/**
 * Tests for ``TerminalRuntimeErrorBanner`` — the recovery surface that
 * the shell-dock loader populates on soft ProcessLoadError. Each kind
 * must render its own copy + a clickable primary action.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, type TerminalRuntimeError, type TerminalRuntimeErrorKind } from '@sdk';
import { TerminalRuntimeErrorBanner } from '@src/components/terminal/interactive-terminal/TerminalRuntimeErrorBanner';

const PROCESS_ID = 'aaaa1111-2222-4333-8444-555555555555';

/** A real one. A spawn refusal quotes the whole worker PATH, and on Windows that
 *  is what turned a one-line banner into a dozen wrapped lines covering the
 *  terminal it was reporting on. */
const HUGE = `claude executable 'claude' not found on worker PATH (${Array.from(
  { length: 20 },
  (_, i) => `C:\\Users\\me\\dir-${i}\\bin`,
).join(';')})`;

const copied: string[] = [];

// Reactive snapshot from ``useContext`` — we drive it from the test.
const mockSnapshot: { terminalRuntimeError: TerminalRuntimeError | null } = {
  terminalRuntimeError: null,
};

vi.mock('@src/hooks/useContext', () => ({
  useContext: () => mockSnapshot,
}));

vi.mock('@sdk', async () => {
  // Keep real Project / TypeId exports; just stub the dataContext mutators.
  const real = await vi.importActual<typeof import('@sdk')>('@sdk');
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

// The clipboard: jsdom has none, and the copy path is the point of the test.
vi.mock('@src/components/ui/copy-button', () => ({
  CopyButton: ({ value, testId }: { value: string; testId?: string }) => (
    <button type="button" data-testid={testId} onClick={() => copied.push(value)} />
  ),
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
    const { container } = render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);
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
    render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);
    const banner = screen.getByTestId('terminal-runtime-error-banner');
    expect(banner.getAttribute('data-error-kind')).toBe(kind);
    expect(banner.textContent).toMatch(titleMatcher);
    const action = screen.getByTestId('terminal-runtime-error-banner-action');
    expect(action.textContent).toMatch(actionMatcher);
  });

  it('Dismiss button calls dataContext.setTerminalRuntimeError(null)', async () => {
    setError('pty_attach_failed');
    const { dataContext } = await import('@sdk');
    render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);
    fireEvent.click(screen.getByTestId('terminal-runtime-error-banner-dismiss'));
    // Asserting ON the spy, never calling it detached, so there is no `this` to
    // lose. Pre-existing; annotated because touching this file makes the hook
    // gate on it.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(dataContext.setTerminalRuntimeError).toHaveBeenCalledWith(null);
  });

  describe('a very long server error', () => {
    beforeEach(() => {
      copied.length = 0;
      setError('failed_to_start');
      // `start_failure` is read off the cached process; stub the lookup so the
      // banner renders the server's sentence rather than its generic copy.
      vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue({ start_failure: HUGE } as never);
    });

    it('shows it on ONE line instead of burying the terminal', () => {
      render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);

      const detail = screen.getByTestId('terminal-runtime-error-banner-detail');
      // `truncate` is the whole fix: one line, ellipsis, no wrapping.
      expect(detail.className).toContain('truncate');
      // And the text is still THERE — trimmed by CSS, never cut, so hover and
      // copy both hand over the real thing.
      expect(detail.textContent).toContain('not found on worker PATH');
      expect(detail.textContent).toContain('dir-19');
    });

    it('copies the full error, not the truncated line', () => {
      render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);

      fireEvent.click(screen.getByTestId('terminal-runtime-error-banner-copy'));

      expect(copied).toHaveLength(1);
      expect(copied[0]).toContain('dir-19');
      expect(copied[0]).not.toContain('…');
    });

    it('offers no copy button for our own boilerplate', () => {
      // `runtime_terminated` has no server sentence — its detail is copy we
      // wrote ("Click Restart to spawn a fresh PTY"). A button to put that on
      // the clipboard is an affordance for nothing; the copy exists for the
      // long verbatim errors someone needs to paste into a report.
      vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(null as never);
      setError('runtime_terminated');
      render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);

      expect(screen.getByTestId('terminal-runtime-error-banner-detail')).toBeTruthy();
      expect(screen.queryByTestId('terminal-runtime-error-banner-copy')).toBeNull();
    });
  });

  describe('whose failure it is', () => {
    // The banner is mounted by EVERY terminal but the error names one process,
    // so a Claude session's launch failure had been showing above a plain
    // terminal's own prompt — with a Retry button that would restart something
    // else entirely. Reported from a screenshot of exactly that.
    beforeEach(() => setError('failed_to_start'));

    it('shows on the terminal whose process failed', () => {
      render(<TerminalRuntimeErrorBanner processId={PROCESS_ID} />);

      expect(screen.getByTestId('terminal-runtime-error-banner')).toBeTruthy();
    });

    it('stays off a plain terminal, which owns no process at all', () => {
      render(<TerminalRuntimeErrorBanner />);

      expect(screen.queryByTestId('terminal-runtime-error-banner')).toBeNull();
    });

    it('stays off a DIFFERENT session, whose launch was fine', () => {
      render(<TerminalRuntimeErrorBanner processId="bbbb2222-3333-4444-8555-666666666666" />);

      expect(screen.queryByTestId('terminal-runtime-error-banner')).toBeNull();
    });
  });
});
