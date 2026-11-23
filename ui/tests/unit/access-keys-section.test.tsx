/**
 * Access keys on the hub's Machines page: a key's card, the "one more step" notice for the
 * machine request the page was opened with, where Add runs the passkey prompt and where it must
 * not (the Electron window), and the add dialog saying why an add failed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  electron: false,
  requestEmailCode: vi.fn(),
  registerPasskey: vi.fn(),
  request: vi.fn(),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  isElectronShell: () => sdk.electron,
  formatAccessKeyCode: (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`,
  listAccessKeys: vi.fn(),
  renameAccessKey: vi.fn(),
  removeAccessKey: vi.fn(),
  requestEmailCode: sdk.requestEmailCode,
  registerPasskey: sdk.registerPasskey,
  accessKeyFailure: (error: { reason: string }) => error.reason,
  remoteControlService: { request: sdk.request },
}));
const openExternal = vi.hoisted(() => vi.fn());
vi.mock('@src/lib/open-external', () => ({ openExternal }));
const runtime = vi.hoisted(() => ({ hubOnly: false }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => runtime.hubOnly }));
const nav = vi.hoisted(() => ({ openDock: vi.fn(), openPreferences: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: nav }) }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));
const handOff = vi.hoisted(() => ({ paths: [] as string[], open: vi.fn() }));
vi.mock('@src/pages/entry/useOpenFlowpad', () => ({
  useOpenInFlowpad: (path: string) => {
    handOff.paths.push(path);
    return handOff.open;
  },
}));
vi.mock('@src/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));

import { AccessKeysSection, REMOTE_CONTROL_PATH } from '@src/pages/hub-home/AccessKeysSection';

const KEY = { id: 'k1', label: 'iCloud Keychain', code: '3f9ac271', backup_eligible: true, request_id: 'r1' };
const REQUEST = { id: 'r1', node: 'compute_node-n1' };

function section(props: { keys?: unknown[]; request?: typeof REQUEST | null } = {}) {
  return render(
    <AccessKeysSection
      keys={(props.keys ?? []) as never}
      reload={vi.fn(() => Promise.resolve())}
      email="dev-7@local.test"
      request={props.request ?? null}
      machineName="MacBook Pro"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sdk.electron = false;
  runtime.hubOnly = false;
  handOff.paths.length = 0;
});

describe('AccessKeysSection', () => {
  it('a key card names the key, how it is kept, and its code in two groups', () => {
    section({ keys: [KEY, { ...KEY, id: 'k2', backup_eligible: false, request_id: null }] });
    const cards = screen.getAllByTestId('access-key-card');
    expect(cards[0].textContent).toContain('iCloud Keychain');
    expect(cards[0].textContent).toContain('Passkey · synced · code 3f9a c271');
    expect(cards[1].textContent).toContain('Passkey · this device · code 3f9a c271');
    expect(screen.getAllByTestId('access-key-code')[0].textContent).toBe('3f9a c271');
    expect(screen.queryByTestId('access-key-finish')).toBeNull();
  });

  it('says "one more step" only once a key exists for the request the page carries', () => {
    const first = section({ keys: [{ ...KEY, request_id: 'other' }], request: REQUEST });
    expect(screen.queryByTestId('access-key-finish')).toBeNull();
    first.unmount();

    section({ keys: [KEY], request: REQUEST });
    expect(screen.getByTestId('access-key-finish').textContent).toContain(
      'One more step · Turn on remote control on MacBook Pro.',
    );
    expect(screen.getByTestId('access-key-open-flowpad').textContent).toBe('Open Flowpad');
  });

  it('Open Flowpad lands on the Remote control panel: in the app by navigation, from the hub by hand-off', async () => {
    expect(REMOTE_CONTROL_PATH).toBe('/dock/assets?remote-control=open');

    // Inside the desktop app: the same address, no hand-off, and never Preferences.
    const inApp = section({ keys: [KEY], request: REQUEST });
    fireEvent.click(screen.getByTestId('access-key-open-flowpad'));
    await waitFor(() => expect(nav.openDock).toHaveBeenCalledTimes(1));
    expect(nav.openDock.mock.calls[0][0].toUrl()).toBe(REMOTE_CONTROL_PATH);
    expect(nav.openPreferences).not.toHaveBeenCalled();
    expect(handOff.open).not.toHaveBeenCalled();
    inApp.unmount();

    // On the hub: the flowpad:// hand-off carries that address; when nothing opens, the way there is spelled out.
    runtime.hubOnly = true;
    handOff.open.mockResolvedValue(false);
    section({ keys: [KEY], request: REQUEST });
    expect(handOff.paths.every((path) => path === REMOTE_CONTROL_PATH)).toBe(true);
    fireEvent.click(screen.getByTestId('access-key-open-flowpad'));
    const fallback = await screen.findByTestId('access-key-no-app');
    expect(fallback.textContent).toBe(
      'Flowpad did not open. On MacBook Pro, open Flowpad, then the menu at the top right → Remote control.',
    );
    expect(nav.openDock).toHaveBeenCalledTimes(1);
  });

  it('in the Electron window Add opens the hub page in the browser, never the passkey dialog', async () => {
    sdk.electron = true;
    sdk.request.mockResolvedValue({ url: 'https://hub.test/dock/hub/machines?access-key-request=r9&node=n' });
    section();
    fireEvent.click(screen.getByTestId('add-access-key-open'));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://hub.test/dock/hub/machines?access-key-request=r9&node=n'),
    );
    expect(screen.queryByTestId('add-access-key-dialog')).toBeNull();
    expect(sdk.requestEmailCode).not.toHaveBeenCalled();
  });

  it('in a browser Add emails the code, ties the key to the request, and words a failure inline', async () => {
    sdk.requestEmailCode.mockResolvedValue({ sent: true, expires_in: 600 });
    sdk.registerPasskey.mockRejectedValue({ reason: 'wrong_code' });
    section({ request: REQUEST });
    fireEvent.click(screen.getByTestId('add-access-key-open'));
    const dialog = await screen.findByTestId('add-access-key-dialog');
    // No key on the account yet: the dialog says this one is the first.
    expect(dialog.textContent).toContain(
      'This is the first key on your account. To check it is you, we emailed a 6-digit code to dev-7@local.test.',
    );
    expect(sdk.requestEmailCode).toHaveBeenCalledTimes(1);

    const submit = screen.getByTestId('add-access-key-continue');
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('add-access-key-code-input'), { target: { value: '482 913' } });
    fireEvent.click(submit);
    const error = await screen.findByTestId('add-access-key-error');
    expect(sdk.registerPasskey).toHaveBeenCalledWith({
      code: '482913',
      requestId: 'r1',
      requestNode: 'compute_node-n1',
    });
    expect(error.getAttribute('data-reason')).toBe('wrong_code');
    expect(screen.getByTestId('add-access-key-dialog')).toBeTruthy();
  });

  it('with a key already on the account the add dialog does not call the new one the first', async () => {
    sdk.requestEmailCode.mockResolvedValue({ sent: true, expires_in: 600 });
    section({ keys: [KEY] });
    fireEvent.click(screen.getByTestId('add-access-key-open'));
    const dialog = await screen.findByTestId('add-access-key-dialog');
    expect(dialog.textContent).toContain('To check it is you, we emailed a 6-digit code to dev-7@local.test.');
    expect(dialog.textContent).not.toContain('first key');
  });
});
