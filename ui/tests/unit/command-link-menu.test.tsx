/**
 * A command link through the shared hook: a click runs the last mode, the menu runs each mode and
 * remembers it, and the Browser ▸ choice reaches every mode. The SDK is stubbed at its edges.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  prefs: new Map<string, unknown>(),
  openTerminal: vi.fn(),
  openNewShell: vi.fn(),
}));

vi.mock('@sdk/client', () => ({ __esModule: true, default: { get: mocks.get, post: mocks.post } }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dataContext: { runtimeKind: 'browser', computeNode: { id: 'local-node' } },
  openTerminalFromComputeNode: mocks.openTerminal,
  instancePreferences: {
    get: (key: string) => mocks.prefs.get(key),
    set: (key: string, value: unknown) => mocks.prefs.set(key, value),
  },
}));
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openNewShell: mocks.openNewShell } }),
}));

const { useLinks } = await import('@src/components/links/LinkMenu');
const { PrefKey } = await import('@sdk');

const LINK = '! gcloud auth login';
const host = {
  id: 'p1',
  supports_shell_command: true,
  workdir: '/w',
  runShellCommand: vi.fn(),
};

let api: ReturnType<typeof useLinks>['handlers'];
function Harness({ process = host as never, trusted = true }: { process?: never | null; trusted?: boolean }) {
  const { handlers, menu } = useLinks({ current: process }, process, { trusted });
  useEffect(() => {
    api = handlers;
  }, [handlers]);
  return <>{menu}</>;
}

const click = () => act(() => api.activate(new MouseEvent('click', { clientX: 5, clientY: 5 }), LINK));
const openMenu = () => act(() => api.openMenu(LINK, 5, 5));
const pick = async (id: string) => fireEvent.click(await screen.findByTestId(`link-menu-${id}`));

beforeEach(() => {
  mocks.prefs.clear();
  // The approval dialog has its own tests below; the rest run as after "Don't ask again".
  mocks.prefs.set(PrefKey.COMMAND_LINK_CONFIRM, false);
  for (const fn of [mocks.get, mocks.post, mocks.openTerminal, mocks.openNewShell, host.runShellCommand]) fn.mockReset();
  mocks.get.mockResolvedValue({ browsers: [{ id: 'chrome', name: 'Google Chrome', profiles: [{ id: 'Profile 1', name: 'Work', email: 'me@work.test' }] }] });
  mocks.post.mockImplementation(async (_path: string, body: { command: string }) => ({ command: `BROWSER=x ${body.command}` }));
});
afterEach(cleanup);

describe('command link click', () => {
  it('runs in chat by default: the session runs it in its shell mode', async () => {
    render(<Harness />);
    click();
    await waitFor(() => expect(host.runShellCommand).toHaveBeenCalledWith('gcloud auth login'));
  });

  it("a command someone else wrote opens the menu and runs nothing", async () => {
    render(<Harness trusted={false} />);
    click();
    expect(await screen.findByTestId('link-menu')).toBeTruthy();
    expect(host.runShellCommand).not.toHaveBeenCalled();
  });

  it('without a session, falls back to a Flowpad terminal', async () => {
    render(<Harness process={null} />);
    click();
    await waitFor(() => expect(mocks.openNewShell).toHaveBeenCalledWith({ startCommand: 'gcloud auth login', cwd: undefined }));
  });
});

describe('command link menu', () => {
  it('shows the command, every mode with the default checked, and Copy command', async () => {
    render(<Harness />);
    openMenu();
    const menu = await screen.findByTestId('link-menu');
    expect(menu.textContent).toContain('gcloud auth login');
    expect(screen.getByTestId('link-menu-run-here').dataset.default).toBe('true');
    for (const id of ['run-flowpad', 'run-external', 'command-browser']) expect(screen.getByTestId(`link-menu-${id}`)).toBeTruthy();
    expect(screen.getByTestId('link-menu-copy').textContent).toContain('Copy command');
  });

  it('a picked mode runs and becomes what a click does', async () => {
    render(<Harness />);
    openMenu();
    await pick('run-flowpad');
    await waitFor(() => expect(mocks.openNewShell).toHaveBeenCalledWith({ startCommand: 'gcloud auth login', cwd: '/w' }));
    expect(mocks.prefs.get(PrefKey.COMMAND_LINK_MODE)).toBe('run-flowpad');
    mocks.openNewShell.mockReset();
    click();
    await waitFor(() => expect(mocks.openNewShell).toHaveBeenCalledTimes(1));
    expect(host.runShellCommand).not.toHaveBeenCalled();
  });

  it('external terminal opens on this machine, in the session folder', async () => {
    render(<Harness />);
    openMenu();
    await pick('run-external');
    await waitFor(() => expect(mocks.openTerminal).toHaveBeenCalledWith('local-node', 'gcloud auth login', '/w', null));
  });
});

async function openBrowserSubmenu() {
  openMenu();
  const trigger = await screen.findByTestId('link-menu-command-browser');
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
}

describe('Browser ▸ choice', () => {
  async function chooseWork() {
    await openBrowserSubmenu();
    await pick('command-browser-chrome-Profile 1');
    expect(mocks.prefs.get(PrefKey.COMMAND_LINK_BROWSER)).toEqual({ browser: 'chrome', profile: 'Profile 1' });
  }

  it.each([
    ['run-here', 'session'],
    ['run-flowpad', 'terminal'],
  ])('%s carries BROWSER for that profile, written for the %s shell', async (mode, target) => {
    render(<Harness />);
    await chooseWork();
    mocks.prefs.set(PrefKey.COMMAND_LINK_MODE, mode);
    click();
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/v1/browser-profiles/command', {
        browser: 'chrome',
        profile: 'Profile 1',
        command: 'gcloud auth login',
        target,
      }),
    );
    if (mode === 'run-here') await waitFor(() => expect(host.runShellCommand).toHaveBeenCalledWith('BROWSER=x gcloud auth login'));
    else await waitFor(() => expect(mocks.openNewShell).toHaveBeenCalledWith({ startCommand: 'BROWSER=x gcloud auth login', cwd: '/w' }));
  });

  it('the external terminal gets the profile itself', async () => {
    render(<Harness />);
    await chooseWork();
    mocks.prefs.set(PrefKey.COMMAND_LINK_MODE, 'run-external');
    click();
    await waitFor(() =>
      expect(mocks.openTerminal).toHaveBeenCalledWith('local-node', 'gcloud auth login', '/w', { browser: 'chrome', profile: 'Profile 1' }),
    );
  });

  it('System default runs the command as written', async () => {
    mocks.prefs.set(PrefKey.COMMAND_LINK_BROWSER, { browser: 'chrome', profile: 'Profile 1' });
    render(<Harness />);
    await openBrowserSubmenu();
    await pick('command-browser-default');
    expect(mocks.prefs.get(PrefKey.COMMAND_LINK_BROWSER)).toBeNull();
    click();
    await waitFor(() => expect(host.runShellCommand).toHaveBeenCalledWith('gcloud auth login'));
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('approval before running', () => {
  beforeEach(() => mocks.prefs.set(PrefKey.COMMAND_LINK_CONFIRM, true));

  it('asks first, showing the command and where; Cancel runs nothing', async () => {
    render(<Harness />);
    click();
    expect((await screen.findByTestId('command-confirm-command')).textContent).toBe('gcloud auth login');
    expect(screen.getByTestId('command-confirm').textContent).toContain("in this chat's session");
    fireEvent.click(screen.getByTestId('command-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('command-confirm')).toBeNull());
    expect(host.runShellCommand).not.toHaveBeenCalled();
  });

  it('Run runs it and asks again next time', async () => {
    render(<Harness />);
    click();
    fireEvent.click(await screen.findByTestId('command-confirm-confirm'));
    await waitFor(() => expect(host.runShellCommand).toHaveBeenCalledTimes(1));
    expect(mocks.prefs.get(PrefKey.COMMAND_LINK_CONFIRM)).toBe(true);
    click();
    expect(await screen.findByTestId('command-confirm')).toBeTruthy();
  });

  it("Don't ask again is saved, and the next click runs straight away", async () => {
    render(<Harness />);
    click();
    fireEvent.click(await screen.findByTestId('command-confirm-dont-ask'));
    fireEvent.click(screen.getByTestId('command-confirm-confirm'));
    await waitFor(() => expect(host.runShellCommand).toHaveBeenCalledTimes(1));
    expect(mocks.prefs.get(PrefKey.COMMAND_LINK_CONFIRM)).toBe(false);
    click();
    await waitFor(() => expect(host.runShellCommand).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('command-confirm')).toBeNull();
  });
});
