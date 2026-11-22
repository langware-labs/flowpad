/**
 * The Remote control panel (it drops from the top bar's menu): the states the machine can report,
 * worded as the approved mock, and that Add / Allow / Turn on / Lock now go through the machine's
 * own service. Turning on is the fingerprint step: it opens the hub page, and nothing is on until
 * the signed answer is confirmed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  status: vi.fn(),
  request: vi.fn(),
  refresh: vi.fn(),
  allow: vi.fn(),
  remove: vi.fn(),
  turnOn: vi.fn(),
  confirm: vi.fn(),
  lock: vi.fn(),
}));
vi.mock('@sdk', () => ({
  remoteControlService: svc,
  decodeAssertion: (text: string) => JSON.parse(text),
  formatAccessKeyCode: (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`,
}));
const openExternal = vi.hoisted(() => vi.fn());
vi.mock('@src/lib/open-external', () => ({ openExternal }));
vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ currentUser: { email: 'dev-7@local.test' } }) }));
// The countdowns read the app's one clock (`useClock`); its module also holds the activity readers, not used here.
vi.mock('@src/store/activity-store', () => ({ useActivitySpec: () => null }));

import { RemoteControlPanel, useRemoteControl } from '@src/components/remote-control/RemoteControlPanel';

/** The panel with its state, as `TopBarMoreMenu` mounts it inside the popover. */
let control: ReturnType<typeof useRemoteControl>;
function Panel() {
  control = useRemoteControl();
  return <RemoteControlPanel control={control} />;
}

const KEY = {
  credential_id: 'cred-1',
  label: 'iCloud Keychain',
  code: '3f9ac271',
  kind: 'passkey',
  state: 'accepted',
  accepted_at: '2026-11-21T10:00:00Z',
  expires_at: null,
};
const PENDING = {
  ...KEY,
  state: 'pending',
  accepted_at: null,
  expires_at: new Date(Date.now() + 7 * 60_000 - 5_000).toISOString(),
};

function status(over: Record<string, unknown> = {}) {
  return {
    available: true,
    reason: null,
    on: false,
    node_typeid: 'compute_node-n1',
    machine_name: 'MacBook Pro',
    keys: [],
    request: null,
    open_until: null,
    hours: null,
    last_off: null,
    hours_options: [1, 3, 10, 24],
    ...over,
  };
}

async function show(first: Record<string, unknown>) {
  svc.status.mockResolvedValue(first);
  svc.refresh.mockResolvedValue(first);
  render(<Panel />);
  const section = await screen.findByTestId('remote-control-section');
  await waitFor(() => expect(section.getAttribute('data-state')).not.toBe('loading'));
  return section;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RemoteControlPanel', () => {
  it.each([
    ['signed_out', 'Sign in to Flowpad to use remote control.'],
    ['private', 'Remote control is not available in private mode.'],
    ['identity', 'Remote control is not available on a machine signed in as an agent.'],
  ])('unavailable (%s): one sentence and nothing else', async (reason, sentence) => {
    const section = await show(status({ available: false, reason }));
    expect(section.getAttribute('data-state')).toBe('unavailable');
    expect(screen.getByTestId('remote-control-unavailable').textContent).toBe(sentence);
    expect(screen.queryByTestId('remote-control-switch')).toBeNull();
    expect(screen.queryByTestId('remote-control-add-key')).toBeNull();
  });

  it('no key: the switch is disabled, and Add opens the hub page the machine names', async () => {
    const section = await show(status());
    expect(section.getAttribute('data-state')).toBe('no-key');
    expect(screen.getByTestId('remote-control-switch').disabled).toBe(true);
    expect(screen.getByTestId('remote-control-hint').textContent).toBe('Add an access key to turn this on.');
    expect(screen.queryByTestId('remote-control-turn-on')).toBeNull();
    expect(screen.queryByTestId('remote-control-window')).toBeNull();
    expect(screen.getByTestId('remote-control-state').textContent).toBe('off');
    expect(screen.getByTestId('remote-control-key-count').textContent).toBe('0');
    expect(screen.getByTestId('remote-control-no-keys').textContent).toBe('No access keys');
    expect(screen.getByTestId('remote-control-add-key').textContent).toBe('Add access key');
    expect(screen.queryByTestId('remote-control-refresh')).toBeNull();

    svc.request.mockResolvedValue({
      url: 'https://hub.test/dock/hub/machines?access-key-request=r1&node=compute_node-n1',
      request_id: 'r1',
      node_typeid: 'compute_node-n1',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    fireEvent.click(screen.getByTestId('remote-control-add-key'));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        'https://hub.test/dock/hub/machines?access-key-request=r1&node=compute_node-n1',
      ),
    );

    // The request is open now: coming back to the window reads the keys again.
    await screen.findByTestId('remote-control-request-open');
    svc.refresh.mockResolvedValue(status({ keys: [KEY] }));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(section.getAttribute('data-state')).toBe('off'));
    expect(svc.refresh).toHaveBeenCalledTimes(2);
  });

  it('opening asks the hub only while a key may be on its way: none accepted yet, or a request open', async () => {
    await show(status({ keys: [KEY] }));
    expect(svc.status).toHaveBeenCalledTimes(1);
    expect(svc.refresh).not.toHaveBeenCalled();
    cleanup();

    await show(
      status({ keys: [KEY], request: { id: 'r1', expires_at: new Date(Date.now() + 600_000).toISOString() } }),
    );
    expect(svc.refresh).toHaveBeenCalledTimes(1);
    cleanup();
    vi.clearAllMocks();

    await show(status({ keys: [PENDING] }));
    expect(svc.refresh).toHaveBeenCalledTimes(1);
    cleanup();
    vi.clearAllMocks();

    await show(status({ available: false, reason: 'signed_out' }));
    expect(svc.refresh).not.toHaveBeenCalled();
  });

  it('pending key: its code, the minutes left, and Allow accepts it', async () => {
    const section = await show(status({ keys: [PENDING] }));
    expect(section.getAttribute('data-state')).toBe('pending');
    const row = screen.getByTestId('remote-control-key-row');
    expect(row.getAttribute('data-state')).toBe('pending');
    expect(row.textContent).toBe('iCloud Keychainnew · code 3f9a c271 · 7 min leftAllow');
    expect(screen.getByTestId('remote-control-key-expiry').textContent).toBe('7 min left');
    expect(screen.getByTestId('remote-control-switch').disabled).toBe(true);

    svc.allow.mockResolvedValue(status({ keys: [KEY] }));
    fireEvent.click(screen.getByTestId('remote-control-allow'));
    await waitFor(() =>
      expect(screen.getByTestId('remote-control-key-row').getAttribute('data-state')).toBe('accepted'),
    );
    expect(svc.allow).toHaveBeenCalledWith('cred-1');
    expect(screen.queryByTestId('remote-control-allow')).toBeNull();
  });

  it('accepted and off: Stay on for 1 h by default, and Turn on opens the fingerprint page for the chosen hours', async () => {
    const section = await show(status({ keys: [KEY] }));
    expect(section.getAttribute('data-state')).toBe('off');
    expect(screen.getByTestId('remote-control-hint').textContent).toBe(
      'Your new key was added from this machine, so it is accepted here.',
    );
    expect(screen.getByTestId('remote-control-key-row').textContent).toBe('iCloud Keychainaccepted · code 3f9a c271');
    expect(section.textContent).toContain('Stay on for1 h3 h10 h24 hTurn on');
    expect(screen.getByTestId('remote-control-window-1').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('remote-control-add-key')).toBeNull();
    expect(screen.queryByTestId('remote-control-open-row')).toBeNull();

    svc.turnOn.mockResolvedValue({
      url: 'https://hub.test/dock/hub/machines?remote-control-confirm=c1&node=compute_node-n1&hours=10',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
    fireEvent.click(screen.getByTestId('remote-control-window-10'));
    expect(screen.getByTestId('remote-control-window-10').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('remote-control-turn-on'));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        'https://hub.test/dock/hub/machines?remote-control-confirm=c1&node=compute_node-n1&hours=10',
      ),
    );
    expect(svc.turnOn).toHaveBeenCalledWith(10);
    // Asking is not being on: that takes the signed answer.
    expect(section.getAttribute('data-state')).toBe('off');

    // The header switch, when off, does what Turn on does.
    fireEvent.click(screen.getByTestId('remote-control-switch'));
    await waitFor(() => expect(svc.turnOn).toHaveBeenCalledTimes(2));
    expect(svc.turnOn).toHaveBeenLastCalledWith(10);
  });

  it.each([
    [
      { last_off: 'expired', hours: 1 },
      'Off. It turned itself off after 1 hour. Turning it on needs your fingerprint again.',
    ],
    [
      { last_off: 'expired', hours: 3 },
      'Off. It turned itself off after 3 hours. Turning it on needs your fingerprint again.',
    ],
    [{ last_off: 'locked', hours: 3 }, 'Off. Turning it on needs your fingerprint again.'],
  ])('off after a window (%j) says how it went off', async (over, sentence) => {
    await show(status({ keys: [KEY], ...over }));
    expect(screen.getByTestId('remote-control-hint').textContent).toBe(sentence);
  });

  it('on: who, the time left and Lock now — no Remove — and the switch locks too', async () => {
    const section = await show(
      status({ keys: [KEY], on: true, hours: 1, open_until: new Date(Date.now() + 60 * 60_000 - 5_000).toISOString() }),
    );
    expect(section.getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('remote-control-state').textContent).toBe('on');
    expect(screen.getByTestId('remote-control-switch').getAttribute('data-state')).toBe('checked');
    expect(screen.getByTestId('remote-control-open-row').textContent).toBe('dev-7@local.test59 min leftLock now');
    expect(screen.queryByTestId('remote-control-hint')).toBeNull();
    expect(screen.queryByTestId('remote-control-remove')).toBeNull();
    expect(screen.queryByTestId('remote-control-turn-on')).toBeNull();
    expect(screen.queryByTestId('remote-control-window')).toBeNull();

    svc.lock.mockResolvedValue(status({ keys: [KEY], hours: 1, last_off: 'locked' }));
    fireEvent.click(screen.getByTestId('remote-control-lock'));
    await waitFor(() => expect(section.getAttribute('data-state')).toBe('off'));
    expect(screen.getByTestId('remote-control-hint').textContent).toBe(
      'Off. Turning it on needs your fingerprint again.',
    );
  });

  it('above an hour the time left is hours and minutes, and the switch, when on, is Lock now', async () => {
    await show(
      status({
        keys: [KEY],
        on: true,
        hours: 3,
        open_until: new Date(Date.now() + 126 * 60_000 - 5_000).toISOString(),
      }),
    );
    expect(screen.getByTestId('remote-control-time-left').textContent).toBe('2 h 5 min left');
    svc.lock.mockResolvedValue(status({ keys: [KEY], hours: 3, last_off: 'locked' }));
    fireEvent.click(screen.getByTestId('remote-control-switch'));
    await waitFor(() => expect(svc.lock).toHaveBeenCalledTimes(1));
  });

  it("confirm hands the decoded answer to the machine; a refusal is said in the machine's words", async () => {
    const section = await show(status({ keys: [KEY] }));
    svc.confirm.mockResolvedValue(
      status({ keys: [KEY], on: true, hours: 1, open_until: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    await act(() => control.confirm(JSON.stringify({ id: 'cred-1' })));
    expect(svc.confirm).toHaveBeenCalledWith({ id: 'cred-1' });
    expect(section.getAttribute('data-state')).toBe('on');

    svc.confirm.mockRejectedValue({ response: { status: 400, data: { message: 'the fingerprint check failed' } } });
    await act(() => control.confirm(JSON.stringify({ id: 'cred-1' })));
    expect(screen.getByTestId('remote-control-error').textContent).toBe('the fingerprint check failed');
  });
});
