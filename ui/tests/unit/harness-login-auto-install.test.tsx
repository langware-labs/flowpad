/**
 * "Try auto install" inside the Assistants & keys modal.
 *
 * This modal is where a person already goes to ask "what is wrong with my
 * assistant" — it lists each harness as Signed in / Not signed in / Not
 * installed. The "Not installed" arm knew the answer and offered only a wiki
 * page: read this guide, install it yourself, come back. The vendor's own
 * one-liner was on the capability row the whole time.
 *
 * So the install affordance now lives on the status surface the user already
 * consults, not only on the two dialogs they reach by failing at something.
 * Same command, same "typed, not run" contract as everywhere else.
 *
 * The guide does not go away: it is the only route on a platform where the
 * vendor publishes no unattended installer, and it stays as the second option
 * for anyone who would rather read first.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openNewShell: vi.fn(),
  openWikiModal: vi.fn(),
  capability: null as unknown,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openNewShell: h.openNewShell, openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/components/wiki-tip/wiki-modal', () => ({ openWikiModal: h.openWikiModal }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: h.capability }),
  usePrimaryContentReady: () => false,
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    // `checked && available` is what the modal turns into "Not installed".
    capabilityManager: {
      getSnapshot: () => ({ capability: h.capability, checked: true, available: false }),
      ensureChecked: () => Promise.resolve({ capability: h.capability, checked: true, available: false }),
      subscribe: () => () => {},
    },
  };
});

import { HarnessDetail } from '@src/components/harness-login/HarnessLoginModal';
import { Dialog, DialogContent } from '@src/components/ui/dialog';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"';

function capabilityWith(installCommand: string | null) {
  return {
    id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    kind: 'harness.claude.cli',
    name: 'Claude CLI',
    install_command: installCommand,
    login_state: null,
    auth_mode: 'device',
    authStatus: () => Promise.resolve(null),
  };
}

const onDone = vi.fn();

/** The panel uses DialogTitle/DialogDescription, so it needs a Dialog ancestor
 *  — the same one the real modal root provides. */
function mount(installCommand: string | null) {
  h.capability = capabilityWith(installCommand);
  render(
    <Dialog open>
      <DialogContent>
        <HarnessDetail kind="harness.claude.cli" onBack={vi.fn()} onDone={onDone} keys={[]} />
      </DialogContent>
    </Dialog>,
  );
}

describe('Assistants & keys — a harness that is not installed', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers to install it, and types the command instead of running it', async () => {
    mount(INSTALL);

    const button = await screen.findByTestId('harness-auto-install');
    fireEvent.click(button);

    expect(h.openNewShell).toHaveBeenCalledWith(
      expect.objectContaining({ prefillCommand: INSTALL, viewMode: 'advanced' }),
    );
    // The modal gets out of the way — otherwise it covers the terminal it just
    // told the user to look at.
    expect(onDone).toHaveBeenCalled();
  });

  it('keeps the setup guide as the only route when there is no installer here', async () => {
    mount(null);

    await waitFor(() => expect(screen.getByText('Show setup guide')).toBeTruthy());
    expect(screen.queryByTestId('harness-auto-install')).toBeNull();
  });
});
