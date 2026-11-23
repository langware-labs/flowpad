/**
 * The hub page's "Turn on remote control" dialog — the fingerprint step. A machine's request in
 * the address opens it and runs the passkey prompt once; the signed answer goes back to the app in
 * the address (by navigation inside the app, by hand-off from the hub), once by itself and again
 * from the button; a cancelled prompt turns nothing on and can be tried again.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ electron: false, signWithPasskey: vi.fn() }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  isElectronShell: () => sdk.electron,
  signWithPasskey: sdk.signWithPasskey,
  encodeAssertion: (assertion: { id: string }) => `enc-${assertion.id}`,
}));
const runtime = vi.hoisted(() => ({ hubOnly: false }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => runtime.hubOnly }));
const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: nav }) }));
const handOff = vi.hoisted(() => ({ path: '', open: vi.fn() }));
vi.mock('@src/pages/entry/useOpenFlowpad', () => ({
  useOpenInFlowpad: (path: string) => {
    handOff.path = path;
    return handOff.open;
  },
}));

import { TurnOnRemoteControlDialog } from '@src/pages/hub-home/TurnOnRemoteControlDialog';

const KEYS = [{ credential_id: 'AQI', transports: ['internal'] }];
const REQUEST = { challenge: 'c1', node: 'compute_node-n1', hours: 1 };
const HAND_OVER = '/dock/assets?remote-control=open&remote-control-assertion=enc-AQI';

function dialog(props: { request?: typeof REQUEST | null; keys?: unknown[] | null; machineName?: string | null } = {}) {
  return render(
    <TurnOnRemoteControlDialog
      request={props.request === undefined ? REQUEST : props.request}
      keys={(props.keys === undefined ? KEYS : props.keys) as never}
      machineName={props.machineName === undefined ? '@MacBook Pro' : props.machineName}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sdk.electron = false;
  runtime.hubOnly = false;
});

describe('TurnOnRemoteControlDialog', () => {
  it('opens on arrival with the machine and the hours, and signs once; a successful sign navigates with the answer', async () => {
    sdk.signWithPasskey.mockResolvedValue({ id: 'AQI' });
    dialog();
    const box = await screen.findByTestId('turn-on-remote-control-dialog');
    expect(box.textContent).toContain('Turn on remote control');
    expect(screen.getByTestId('turn-on-remote-control-line').textContent).toBe(
      'MacBook Pro · for 1 hour · confirm with your passkey',
    );
    expect(sdk.signWithPasskey).toHaveBeenCalledTimes(1);
    expect(sdk.signWithPasskey).toHaveBeenCalledWith({ challenge: 'c1', keys: KEYS });

    // Signed: back to the app by itself, once, at the address that carries the answer.
    const done = await screen.findByTestId('turn-on-remote-control-done');
    expect(done.textContent).toBe('Fingerprint confirmed. Go back to Flowpad to finish.');
    await waitFor(() => expect(nav.openDock).toHaveBeenCalledTimes(1));
    expect(nav.openDock.mock.calls[0][0].toUrl()).toBe(HAND_OVER);
    expect(handOff.open).not.toHaveBeenCalled();
    // The button stays, and goes there again.
    fireEvent.click(screen.getByTestId('turn-on-remote-control-open'));
    expect(nav.openDock).toHaveBeenCalledTimes(2);
    expect(sdk.signWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('on the hub the answer goes through the flowpad:// hand-off; when nothing opens it says so', async () => {
    runtime.hubOnly = true;
    sdk.signWithPasskey.mockResolvedValue({ id: 'AQI' });
    handOff.open.mockResolvedValue(false);
    dialog({ request: { ...REQUEST, hours: 3 }, machineName: null });
    expect((await screen.findByTestId('turn-on-remote-control-line')).textContent).toBe(
      'your machine · for 3 hours · confirm with your passkey',
    );
    await waitFor(() => expect(handOff.open).toHaveBeenCalledTimes(1));
    expect(handOff.path).toBe(HAND_OVER);
    expect(nav.openDock).not.toHaveBeenCalled();
    expect((await screen.findByTestId('turn-on-remote-control-no-app')).textContent).toContain('Flowpad did not open.');
  });

  it('a cancelled prompt says "Nothing was turned on." and the button tries again', async () => {
    sdk.signWithPasskey.mockRejectedValueOnce({ name: 'NotAllowedError' });
    dialog();
    const error = await screen.findByTestId('turn-on-remote-control-error');
    expect(error.textContent).toBe('Nothing was turned on.');
    expect(nav.openDock).not.toHaveBeenCalled();

    sdk.signWithPasskey.mockResolvedValue({ id: 'AQI' });
    fireEvent.click(screen.getByTestId('turn-on-remote-control-confirm'));
    await screen.findByTestId('turn-on-remote-control-done');
    expect(sdk.signWithPasskey).toHaveBeenCalledTimes(2);
  });

  it('an account with no access key is told so, and nothing is asked of the browser', async () => {
    dialog({ keys: [] });
    const error = await screen.findByTestId('turn-on-remote-control-error');
    expect(error.textContent).toBe('No matching access key on this account.');
    expect(sdk.signWithPasskey).not.toHaveBeenCalled();
  });

  it('stays closed in the Electron window, without a request, and until the keys are read', () => {
    sdk.electron = true;
    dialog();
    expect(screen.queryByTestId('turn-on-remote-control-dialog')).toBeNull();
    cleanup();
    sdk.electron = false;
    dialog({ request: null });
    expect(screen.queryByTestId('turn-on-remote-control-dialog')).toBeNull();
    cleanup();
    dialog({ keys: null });
    expect(screen.queryByTestId('turn-on-remote-control-dialog')).toBeNull();
    expect(sdk.signWithPasskey).not.toHaveBeenCalled();
  });
});
