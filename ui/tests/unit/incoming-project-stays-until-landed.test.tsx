/**
 * The shared-project set-up dialog stays up after set-up succeeds until the app has
 * actually left the page the set-up started on. Landing in the project redirects to
 * its home page, which may be an agent's chat (`/dock/vibe/…`) rather than the
 * project dock — a dialog that waited for the project dock spun forever over the
 * chat, and one that closed on a timer showed the app home while the landing loaded.
 *
 * Real `IncomingProjectDialog`. Stand-ins are the boundaries: dock navigation (the
 * URL it reads), the install-and-land hook, and the project lookup.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ url: '/', install: vi.fn() }));

// Project setup waits for the first-run wizard (`first-run-gate.tsx`); here that wizard is done.
vi.mock('@src/components/project-setup/first-run-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/project-setup/first-run-gate')>()),
  useFirstRunGate: () => ({ state: 'open', continueAnyway: vi.fn() }),
}));

vi.mock('@src/components/agent-layout/agent-layout', () => ({ useAgentContext: () => ({ computeNode: null }) }));
vi.mock('@src/components/project-selector', () => ({
  useCloneGitProjectAndOpen: () => vi.fn(),
  useInstallSharedProjectAndOpen: () => h.install,
}));
vi.mock('@src/components/project-selector/use-ensure-project', () => ({ useSelectExistingProject: () => vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: { toUrl: () => h.url } }),
}));

import { Project } from '@sdk';
import { IncomingProjectDialog } from '@src/components/task-receive/IncomingProjectDialog';

const ORIGIN = {
  owner: 'acme',
  name: 'course',
  url: 'https://github.com/acme/course.git',
  branch: 'main',
  rel_path: '',
};
const SHARED = '11111111-1111-4111-8111-111111111111';

function dialog(onClose: () => void) {
  return (
    <IncomingProjectDialog
      open
      gitOrigin={ORIGIN as never}
      projectName="course"
      senderName="Dana"
      projectId={SHARED}
      onClose={onClose}
    />
  );
}

afterEach(() => {
  cleanup();
  h.url = '/';
  h.install.mockReset();
  vi.restoreAllMocks();
});

describe('the shared-project set-up dialog after a successful set-up', () => {
  it('stays up on the page it started on, and closes once the landing moves the URL — to a chat too', async () => {
    vi.spyOn(Project, 'getByIdFromCache').mockReturnValue({ id: SHARED } as never);
    vi.spyOn(Project, 'getById').mockResolvedValue({ id: SHARED } as never);
    h.install.mockResolvedValue({ id: SHARED });
    const onClose = vi.fn();
    const { rerender } = render(dialog(onClose));

    fireEvent.click(screen.getByTestId('incoming-project-install'));

    // Set up, landing still loading: the URL has not moved, so the app home stays covered.
    await waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    await screen.findByText(/Opening your project/);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('incoming-project-dialog')).toBeTruthy();

    // The project's home page is an agent chat: the landing commits there.
    h.url = '/dock/vibe/agentic_process-33333333-3333-4333-8333-333333333333';
    rerender(dialog(onClose));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
