// The "Desktop Update Required" popup (FLOWPAD-2310): what it says and which ways out it offers.
// Panel rule: a desktop update never leaves the engine behind — the only update action is Update Both.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopUpdateModal, type DesktopUpdateRequiredInfo } from '@src/components/version-popover/desktop-update-modal';

const INFO: DesktopUpdateRequiredInfo = {
  engineTarget: '0.2.240',
  minDesktop: '0.2.60',
  desktopInstalled: '0.2.50',
  desktopAvailable: '0.2.62',
};

function renderModal(over: Partial<Parameters<typeof DesktopUpdateModal>[0]> = {}) {
  const onUpdateBoth = vi.fn();
  const onClose = vi.fn();
  render(
    <DesktopUpdateModal
      open
      info={INFO}
      busy={false}
      error={null}
      onUpdateBoth={onUpdateBoth}
      onClose={onClose}
      {...over}
    />,
  );
  return { onUpdateBoth, onClose };
}

afterEach(cleanup);

describe('DesktopUpdateModal', () => {
  it('offers Update Both and Cancel when a newer desktop exists — never a desktop-only path', () => {
    const { onUpdateBoth, onClose } = renderModal();
    expect(screen.getByTestId('desktop-update-required-modal').textContent).toContain('Desktop Update Required');

    fireEvent.click(screen.getByTestId('update-both-button'));
    expect(onUpdateBoth).toHaveBeenCalledTimes(1);
    // The update ACTIONS on offer are exactly Update Both and Cancel (a third would be a desktop-only path).
    const actions = Array.from(
      screen.getByTestId('desktop-update-required-modal').querySelectorAll('[data-testid^="update-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(actions).toEqual(['update-both-button', 'update-cancel-button']);
    fireEvent.click(screen.getByTestId('update-cancel-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed while a call is in flight (its refusal would land on a closed popup)', () => {
    const { onClose } = renderModal({ busy: true });
    fireEvent.keyDown(screen.getByTestId('desktop-update-required-modal'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is dismissed with Escape when idle', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByTestId('desktop-update-required-modal'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('names both floors: the version asked for and the desktop it requires', () => {
    renderModal();
    const text = screen.getByTestId('desktop-update-required-modal').textContent ?? '';
    expect(text).toContain('0.2.240'); // the engine release the user asked for
    expect(text).toContain('0.2.60'); // its minimum desktop
    expect(text).toContain('0.2.50'); // the desktop they have
    expect(text).toContain('0.2.62'); // the desktop on offer
  });

  it('no newer desktop published: explains, prevents the install, and offers only Cancel', () => {
    renderModal({ info: { ...INFO, desktopAvailable: null } });
    expect(screen.queryByTestId('update-both-button')).toBeNull();
    expect(screen.getByTestId('update-cancel-button')).toBeTruthy();
    expect(screen.getByTestId('desktop-update-required-modal').textContent).toContain('No newer FlowPad Desktop');
  });

  it('a FAILED feed check is not "no build published": says to try again, not to wait for a release', () => {
    renderModal({ info: { ...INFO, desktopAvailable: null, checkFailed: true } });
    expect(screen.queryByTestId('update-both-button')).toBeNull();
    const text = screen.getByTestId('desktop-update-required-modal').textContent ?? '';
    expect(text).toContain('could not be checked');
    expect(text).not.toContain('No newer FlowPad Desktop');
  });

  it('a desktop build exists but no engine target: no Update Both, honest advice instead', () => {
    renderModal({ info: { ...INFO, engineTarget: null } });
    expect(screen.queryByTestId('update-both-button')).toBeNull();
    expect(screen.getByTestId('desktop-update-required-modal').textContent).toContain('could not be');
  });

  it('busy disables every action (no duplicate update operations)', () => {
    const { onUpdateBoth } = renderModal({ busy: true });
    const both = screen.getByTestId('update-both-button');
    expect((both as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(both);
    expect(onUpdateBoth).not.toHaveBeenCalled();
    expect((screen.getByTestId('update-cancel-button')).disabled).toBe(true);
  });

  it('shows the error from a refused action', () => {
    renderModal({ error: 'Another update is already in progress.' });
    expect(screen.getByTestId('desktop-update-required-modal').textContent).toContain(
      'Another update is already in progress.',
    );
  });
});
