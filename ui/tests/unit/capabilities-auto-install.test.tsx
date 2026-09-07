/**
 * "Try auto install" on the Capabilities page.
 *
 * The Capabilities view is where a person LANDS when a harness is missing — a
 * failed spawn routes here, and its arrival re-probe is what corrects the stale
 * capability row. Until now the only things offered here were "Refresh status"
 * and "Set up", which spawns an agentic process to go and figure the install
 * out. The vendor's own published one-liner was on the row all along
 * (`CapabilityAccess.install_command`, resolved by the backend for THIS
 * platform) and nothing rendered it.
 *
 * Two rules the button obeys, both pinned below:
 *  - offered only for something ACTUALLY MISSING — never next to a harness the
 *    machine already has;
 *  - absent entirely when the vendor ships no unattended installer here (e.g.
 *    OpenCode on Windows), rather than handing over a command that cannot work.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openNewShell: vi.fn(),
  summary: null as unknown,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openNewShell: h.openNewShell, openDock: vi.fn(), openTab: vi.fn() },
    currentDock: null,
  }),
}));
vi.mock('@sdk/react/hooks/useLazyAsset', () => ({ useLazyAsset: () => ({ isLoading: false, error: null }) }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/hooks/use-flow-data-trace', () => ({ useFlowDataTrace: () => [] }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  capabilityManager: {
    getCachedSummary: () => h.summary,
    getSummary: () => Promise.resolve(h.summary),
    subscribe: () => () => {},
    test: vi.fn(),
    setup: vi.fn(),
  },
}));

import { CapabilitiesView } from '@src/components/capabilities-view/CapabilitiesView';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"';

function summaryWith(overrides: Record<string, unknown>) {
  const access = {
    kind: 'harness.claude.cli',
    intent: 'harness',
    name: 'Claude CLI',
    description: '',
    icon: 'Bot',
    available: false,
    checked: true,
    state: 'not_available',
    runnable: true,
    installable: true,
    worker_type: 'claude_code',
    homepage_url: null,
    install_command: INSTALL,
    reference_kind: null,
    dependencies: [],
    value: null,
    value_type: 'folder',
    last_process_id: null,
    message: 'claude CLI was not found in PATH.',
    ...overrides,
  };
  return {
    intents: [{ intent: 'harness', label: 'Harness', available: !!access.available, capabilities: [access] }],
    capabilities: [access],
    generated_at: '2026-09-06T00:00:00Z',
  };
}

/** Scoped to THIS render's container: the suite mounts the view repeatedly,
 *  and a global `screen` query would read a previous mount's DOM. */
function mount(summary: unknown) {
  h.summary = summary;
  const { container } = render(<CapabilitiesView />);
  const q = within(container);
  return {
    button: () => q.queryByTestId('capability-auto-install-harness.claude.cli'),
    row: () => q.queryByText('Claude CLI'),
  };
}

describe('Capabilities page auto-install', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers the command for a harness that is missing', async () => {
    const { button } = mount(summaryWith({}));

    await waitFor(() => expect(button()).toBeTruthy());
  });

  it('types it into a terminal instead of running it', async () => {
    const { button } = mount(summaryWith({}));
    await waitFor(() => expect(button()).toBeTruthy());

    fireEvent.click(button()!);

    // `prefillCommand`, never `startCommand`: the line is typed at the prompt
    // and the user presses Enter. Piping a remote install script into a shell
    // is their keystroke to make.
    expect(h.openNewShell).toHaveBeenCalledWith(
      expect.objectContaining({ prefillCommand: INSTALL, viewMode: 'advanced' }),
    );
  });

  it('does not offer to install what the machine already has', async () => {
    const { button, row } = mount(summaryWith({ available: true, state: 'available', message: 'test passed.' }));

    // Wait for the row before concluding the button is absent — otherwise this
    // passes on an empty render and proves nothing.
    await waitFor(() => expect(row()).toBeTruthy());
    expect(button()).toBeNull();
  });

  it('offers nothing when the vendor ships no installer for this platform', async () => {
    // The backend resolves `install_command` per platform and sends null when
    // there is no unattended route — OpenCode on Windows is the real case.
    const { button, row } = mount(summaryWith({ install_command: null }));

    await waitFor(() => expect(row()).toBeTruthy());
    expect(button()).toBeNull();
  });
});
