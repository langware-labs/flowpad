/**
 * The version popover's update flow (FLOWPAD-2310):
 *   - "Upgrade" pre-flights compatibility through the shell and opens the "Desktop Update Required"
 *     popup instead of starting an upgrade the shell would refuse;
 *   - a failed upgrade is SHOWN (regression: the IPC result used to be dropped on the floor);
 *   - the Desktop section's own row: Download when available, Update Now when downloaded (including
 *     an update postponed earlier with the native "Later"), Up to date when current;
 *   - without Electron the button keeps the browser path (POST /api/v1/version/install).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@sdk/websocket', () => ({ connectionManager: { id: 'conn-test' } }));
vi.mock('@src/components/markdown-view', () => ({ MarkdownView: () => null }));
vi.mock('@src/components/version-popover/diagnose-modal', () => ({ DiagnoseModal: () => null }));
vi.mock('@src/components/version-popover/diagnosis-report-modal', () => ({ DiagnosisReportModal: () => null }));
vi.mock('@src/components/llm-sources/llm-sources-pointer', () => ({ openLlmSources: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/components/view-mode', () => ({ useIsDev: () => false }));
vi.mock('@src/hooks/use-preference', () => ({ usePreference: () => [undefined] }));
vi.mock('@sdk/react/hooks', () => ({ useContext: () => null }));
vi.mock('@src/notifications/notify', () => ({
  notify: Object.assign(vi.fn(), { success: h.notifySuccess, error: h.notifyError, dismiss: vi.fn() }),
}));

import { VersionPopover } from '@src/components/version-popover/version-popover';

const CHECK: unknown = {
  pypi: {
    current: '0.2.230',
    latest: '0.2.240',
    update_available: true,
    error: null,
    releases: [{ version: '0.2.240', published_at: null, yanked: false }],
  },
  latest_release: null,
  releases: [],
  github_error: null,
  installed_at: null,
  hub: null,
};

/** A full window.electronAPI double; override what the case needs. */
function electronApi(over: Record<string, unknown> = {}) {
  return {
    getAppVersion: vi.fn().mockResolvedValue('0.2.50'),
    upgradeFlowpad: vi.fn().mockResolvedValue({ success: true }),
    getUpdateInfo: vi.fn().mockResolvedValue({
      desktop: { installed: '0.2.50', state: 'current', available: null, downloadState: 'idle' },
      engine: {
        installed: '0.2.230',
        latest: '0.2.240',
        updateAvailable: true,
        latestMinDesktop: null,
        latestCompatible: true,
        newestCompatible: null,
      },
      busy: false,
      resumed: null,
    }),
    downloadDesktopUpdate: vi.fn().mockResolvedValue({ started: true, version: '0.2.62' }),
    applyDesktopUpdate: vi.fn().mockResolvedValue({ started: true, version: '0.2.62' }),
    updateBoth: vi.fn().mockResolvedValue({ started: true, version: '0.2.62' }),
    onDesktopUpdateState: vi.fn().mockReturnValue(() => {}),
    onEngineUpdateResumed: vi.fn().mockReturnValue(() => {}),
    takeResumedUpdate: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

const INCOMPATIBLE_INFO = {
  desktop: { installed: '0.2.50', state: 'available', available: '0.2.62', downloadState: 'idle' },
  engine: {
    installed: '0.2.230',
    latest: '0.2.240',
    updateAvailable: true,
    latestMinDesktop: '0.2.60',
    latestCompatible: false,
    newestCompatible: '0.2.235',
  },
  busy: false,
  resumed: null,
};

async function openPopover() {
  render(<VersionPopover currentVersion="0.2.230" />);
  fireEvent.click(screen.getByTestId('version-popover-trigger'));
  await screen.findByTestId('version-upgrade-button');
}

beforeEach(() => {
  h.get.mockResolvedValue(CHECK);
  h.post.mockResolvedValue({ success: true, restarting: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('Upgrade pre-flight (desktop app)', () => {
  it('an incompatible latest release opens the Desktop Update Required popup instead of upgrading', async () => {
    const api = electronApi({ getUpdateInfo: vi.fn().mockResolvedValue(INCOMPATIBLE_INFO) });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    const modal = await screen.findByTestId('desktop-update-required-modal');
    expect(api.upgradeFlowpad).not.toHaveBeenCalled();
    expect(modal.textContent).toContain('0.2.60'); // the floor the release demands
    expect(screen.getByTestId('update-both-button')).toBeTruthy();
    expect(screen.queryByTestId('update-desktop-only-button')).toBeNull(); // panel rule: both update together
    expect(screen.getByTestId('update-cancel-button')).toBeTruthy();
  });

  it('Update Both hands the shell the exact engine version on offer', async () => {
    const api = electronApi({ getUpdateInfo: vi.fn().mockResolvedValue(INCOMPATIBLE_INFO) });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    fireEvent.click(await screen.findByTestId('update-both-button'));
    await waitFor(() => expect(api.updateBoth).toHaveBeenCalledWith('0.2.240'));
    await waitFor(() => expect(screen.queryByTestId('desktop-update-required-modal')).toBeNull());
  });

  it('a compatible release upgrades through the shell, with no popup and no warnings', async () => {
    const api = electronApi();
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    await waitFor(() => expect(api.upgradeFlowpad).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('desktop-update-required-modal')).toBeNull();
  });

  it('a failed upgrade is shown, not dropped (the old handler ignored the IPC result)', async () => {
    const api = electronApi({
      upgradeFlowpad: vi.fn().mockResolvedValue({ success: false, error: 'uv exploded' }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    const err = await screen.findByTestId('upgrade-error');
    expect(err.textContent).toContain('uv exploded');
  });

  it("the shell's desktop-first refusal (desktopUpdatePending) opens the same popup", async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({ ...INCOMPATIBLE_INFO, engine: null }),
      upgradeFlowpad: vi.fn().mockResolvedValue({ success: false, desktopUpdatePending: true, error: 'desktop first' }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    await screen.findByTestId('desktop-update-required-modal');
    expect(screen.queryByTestId('upgrade-error')).toBeNull();
  });

  it('held with a COMPATIBLE engine: the popup explains the pending desktop, not a false floor claim', async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        ...INCOMPATIBLE_INFO,
        engine: { ...INCOMPATIBLE_INFO.engine, latestCompatible: true, latestMinDesktop: '0.2.40' },
      }),
      upgradeFlowpad: vi.fn().mockResolvedValue({ success: false, desktopUpdatePending: true, error: 'desktop first' }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    const modal = await screen.findByTestId('desktop-update-required-modal');
    expect(modal.textContent).toContain('update is pending');
    expect(modal.textContent).not.toContain('or newer — you have'); // the installed desktop MEETS the floor
  });
});

describe('the Desktop section row', () => {
  it('a newer build on the feed: Download updates BOTH when a newer flow SDK exists too', async () => {
    const api = electronApi({ getUpdateInfo: vi.fn().mockResolvedValue(INCOMPATIBLE_INFO) });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    const btn = await screen.findByTestId('desktop-download-button');
    expect(btn.textContent).toContain('0.2.62');
    fireEvent.click(btn);
    await waitFor(() => expect(api.updateBoth).toHaveBeenCalledWith('0.2.240'));
    expect(api.downloadDesktopUpdate).not.toHaveBeenCalled();
  });

  it("the feed build is below the engine's floor: Download falls back to desktop-only", async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        ...INCOMPATIBLE_INFO,
        desktop: { ...INCOMPATIBLE_INFO.desktop, meetsEngineFloor: false },
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    fireEvent.click(await screen.findByTestId('desktop-download-button'));
    await waitFor(() => expect(api.downloadDesktopUpdate).toHaveBeenCalledTimes(1));
    expect(api.updateBoth).not.toHaveBeenCalled(); // update:both would refuse (desktop-too-old)
  });

  it("a stale error push does not outlive the shell's idle snapshot", async () => {
    let pushState: ((s: unknown) => void) | null = null;
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue(INCOMPATIBLE_INFO), // downloadState idle, a build available
      onDesktopUpdateState: vi.fn((cb: (s: unknown) => void) => {
        pushState = cb;
        return () => {};
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    act(() => pushState?.({ state: 'error', error: 'old failure' }));
    await screen.findByTestId('desktop-update-retry-button');
    fireEvent.click(screen.getByTestId('version-popover-trigger')); // close…
    fireEvent.click(screen.getByTestId('version-popover-trigger')); // …reopen → refresh → idle clears the push
    await screen.findByTestId('desktop-download-button');
    expect(screen.queryByTestId('desktop-update-retry-button')).toBeNull();
  });

  it("the shell refuses desktop-too-old (pre-flight floor was unknown): Download retries desktop-only", async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue(INCOMPATIBLE_INFO), // meetsEngineFloor undefined → both attempted
      updateBoth: vi.fn().mockResolvedValue({ started: false, reason: 'desktop-too-old', minDesktop: '0.3.0' }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    fireEvent.click(await screen.findByTestId('desktop-download-button'));
    await waitFor(() => expect(api.downloadDesktopUpdate).toHaveBeenCalledTimes(1));
    expect(api.updateBoth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/older than this release requires/)).toBeNull(); // no error shown — it fell back
  });

  it('no newer flow SDK: Download stays a plain desktop download', async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        ...INCOMPATIBLE_INFO,
        engine: { ...INCOMPATIBLE_INFO.engine, updateAvailable: false, latestCompatible: true },
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    fireEvent.click(await screen.findByTestId('desktop-download-button'));
    await waitFor(() => expect(api.downloadDesktopUpdate).toHaveBeenCalledTimes(1));
    expect(api.updateBoth).not.toHaveBeenCalled();
  });

  it('an update downloaded earlier (postponed with "Later"): Update Now installs it', async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        ...INCOMPATIBLE_INFO,
        desktop: { installed: '0.2.50', state: 'available', available: '0.2.62', downloadState: 'ready' },
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();

    const btn = await screen.findByTestId('desktop-update-now-button');
    fireEvent.click(btn);
    await waitFor(() => expect(api.applyDesktopUpdate).toHaveBeenCalledTimes(1));
  });

  it('already the latest: says Up to date, no buttons', async () => {
    (window as { electronAPI?: unknown }).electronAPI = electronApi();
    await openPopover();
    await screen.findByTestId('desktop-up-to-date');
    expect(screen.queryByTestId('desktop-download-button')).toBeNull();
    expect(screen.queryByTestId('desktop-update-now-button')).toBeNull();
  });

  it('a failed feed check: says so and offers Check again (not a blank row, not Up to date)', async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        desktop: { installed: '0.2.50', state: 'unknown', available: null, downloadState: 'idle' },
        engine: null,
        busy: false,
        resumed: null,
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    const row = await screen.findByTestId('desktop-check-failed');
    expect(row.textContent).toContain('Could not check');
    expect(screen.queryByTestId('desktop-up-to-date')).toBeNull();
    fireEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(api.getUpdateInfo.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("the feed's build is below the engine's floor: the popup says to wait — no Update Both", async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        ...INCOMPATIBLE_INFO,
        desktop: { ...INCOMPATIBLE_INFO.desktop, meetsEngineFloor: false },
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    const modal = await screen.findByTestId('desktop-update-required-modal');
    expect(modal.textContent).toContain('No newer FlowPad Desktop');
    expect(screen.queryByTestId('update-both-button')).toBeNull();
    expect(api.updateBoth).not.toHaveBeenCalled();
  });

  it('no suitable desktop build, but a compatible flow SDK exists: the popup offers it', async () => {
    const api = electronApi({
      getUpdateInfo: vi.fn().mockResolvedValue({
        ...INCOMPATIBLE_INFO,
        desktop: { installed: '0.2.50', state: 'current', available: null, downloadState: 'idle' },
      }),
    });
    (window as { electronAPI?: unknown }).electronAPI = api;
    await openPopover();
    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    const btn = await screen.findByTestId('update-compatible-button');
    expect(btn.textContent).toContain('0.2.235'); // engine.newestCompatible — runs on THIS desktop
    fireEvent.click(btn);
    // The pin is what lets the shell bypass its desktop-first hold for exactly this release.
    await waitFor(() => expect(api.upgradeFlowpad).toHaveBeenCalledWith({ version: '0.2.235' }));
    expect(screen.queryByTestId('desktop-update-required-modal')).toBeNull();
    expect(api.updateBoth).not.toHaveBeenCalled();
  });

  it('a resumed coordinated update reports its outcome once — even when push AND pull both deliver it', async () => {
    const resumed = { success: true, engineVersion: '0.2.240', desktopVersion: '0.2.62' };
    let pushResumed: ((r: unknown) => void) | null = null;
    (window as { electronAPI?: unknown }).electronAPI = electronApi({
      takeResumedUpdate: vi.fn().mockResolvedValue(resumed), // the mount-time pull
      onEngineUpdateResumed: vi.fn((cb: (r: unknown) => void) => {
        pushResumed = cb;
        return () => {};
      }),
    });
    await openPopover();
    await waitFor(() => expect(h.notifySuccess).toHaveBeenCalledTimes(1));
    pushResumed?.(resumed); // the startup push races the mount pull: same outcome, no second toast
    expect(h.notifySuccess).toHaveBeenCalledTimes(1);
  });
});

describe('browser mode (no Electron)', () => {
  it('the Upgrade button posts /api/v1/version/install, untouched by the desktop flow', async () => {
    await openPopover();
    expect(screen.queryByTestId('desktop-download-button')).toBeNull();
    fireEvent.click(screen.getByTestId('version-upgrade-button'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/v1/version/install', { version: '0.2.240' }));
  });
});
