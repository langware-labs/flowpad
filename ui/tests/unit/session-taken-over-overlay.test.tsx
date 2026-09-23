/**
 * `SessionTakenOverOverlay` — the render side of `takenOver`
 * (`cloud-manager-takeover.test.ts` covers the flag's own state machine).
 * This file pins the one thing that actually matters to the person looking
 * at the screen: the block is invisible unless `takenOver` is true, and
 * visible with working copy + a working "Log in" when it is.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  login: vi.fn(),
  takenOver: false,
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cloudManager: { login: h.login },
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCloudStatus: () => ({ takenOver: h.takenOver }),
}));

const { default: SessionTakenOverOverlay } = await import('@src/components/session-taken-over-overlay');

afterEach(() => {
  cleanup();
  h.takenOver = false;
  vi.clearAllMocks();
});

describe('SessionTakenOverOverlay', () => {
  it('renders nothing when nobody has taken the machine over', () => {
    h.takenOver = false;
    const { container } = render(<SessionTakenOverOverlay />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('session-taken-over-overlay')).toBeNull();
  });

  it('blocks the screen with the takeover notice when takenOver is true', () => {
    h.takenOver = true;
    render(<SessionTakenOverOverlay />);

    expect(screen.getByTestId('session-taken-over-overlay')).toBeTruthy();
    expect(screen.getByText('Someone else is using this machine')).toBeTruthy();
    expect(screen.getByTestId('session-taken-over-overlay-button')).toBeTruthy();
  });

  it('reclaiming the machine calls the normal cloud login entry point', async () => {
    h.takenOver = true;
    render(<SessionTakenOverOverlay />);

    await userEvent.click(screen.getByTestId('session-taken-over-overlay-button'));

    expect(h.login).toHaveBeenCalledOnce();
  });
});
