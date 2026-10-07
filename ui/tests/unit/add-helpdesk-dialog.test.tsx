/**
 * AddHelpdeskDialog — what the user is TOLD after a desk is attached.
 *
 * The backend already decided what happened; this dialog's whole job is not to
 * misreport it. Three of the six outcomes did find a desk and still must not
 * read as success, so "did we get a helpdesk_id" is exactly the wrong question
 * for the UI to ask — these tests pin that it keys on `outcome` instead.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataContext: { userTypeId: { type: 'user', id: 'u1' } },
    dataManager: {
      // `github/status` — not connected, so the browse path stays collapsed and
      // the pasted-URL path (the one under test) is what renders.
      callAction: vi.fn(() => Promise.resolve({ has_token: false })),
      on: vi.fn(),
      off: vi.fn(),
    },
    oauthService: { connect: vi.fn() },
  };
});

vi.mock('@src/components/git/RepoPicker', () => ({ RepoPicker: () => null }));
vi.mock('@src/components/git/InvitationsStrip', () => ({ InvitationsStrip: () => null }));
vi.mock('@src/journey/SetupJourneyButton', () => ({
  SETUP_GITHUB_JOURNEY_ID: 'j1',
  SetupJourneyButton: () => null,
}));

const navMocks = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: navMocks.openDock }, currentDock: null }),
}));

import { AddHelpdeskDialog } from '@src/components/helpdesk/AddHelpdeskDialog';

const DESK_URL = 'https://github.com/langware-labs/langware-support';

const BASE = {
  dependency: 'langware-support',
  path: '/w/langware-support',
  already_linked: false,
  helpdesk_id: 'h1',
  display_name: 'CloudNSite Support',
  welcome_message: 'Ask us anything.',
  avatar_url: null,
  desk_project_id: 'q1',
  portal_project_id: 'p1',
  shadowed_by: null,
};

function makeProject(result: Record<string, unknown>) {
  return {
    id: 'proj-1',
    adoptHelpdeskFromGit: vi.fn(() => Promise.resolve(result)),
    removeDependency: vi.fn(() => Promise.resolve([])),
  };
}

function renderDialog(project: ReturnType<typeof makeProject>, onAdded = vi.fn()) {
  return render(
    <MemoryRouter>
      {/* The required/optional chips explain themselves through Radix tooltips, which the
          app provides at root (App.tsx). */}
      <TooltipProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <AddHelpdeskDialog open onOpenChange={() => {}} project={project as any} onAdded={onAdded} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

async function pasteAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId('add-helpdesk-url'), DESK_URL);
  await user.click(screen.getByTestId('add-helpdesk-submit'));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddHelpdeskDialog', () => {
  it('adopts a pasted URL as a required dependency and offers to open it', async () => {
    const user = userEvent.setup();
    const project = makeProject({ ...BASE, outcome: 'adopted' });
    const onAdded = vi.fn();
    renderDialog(project, onAdded);

    await pasteAndSubmit(user);

    await waitFor(() => expect(project.adoptHelpdeskFromGit).toHaveBeenCalled());
    // Required by default: the desk is what this project's tickets go to, so
    // it is fetched wherever the project opens. Optional is a deliberate choice.
    expect(project.adoptHelpdeskFromGit).toHaveBeenCalledWith(DESK_URL, '', false);

    expect(await screen.findByTestId('add-helpdesk-result-adopted')).toBeTruthy();
    expect(screen.getByText('CloudNSite Support')).toBeTruthy();
    // The context rows are stale after any attach — the host must refetch.
    expect(onAdded).toHaveBeenCalled();

    await user.click(screen.getByTestId('add-helpdesk-open'));
    expect(navMocks.openDock).toHaveBeenCalledTimes(1);
  });

  it('does not claim success when another desk keeps answering', async () => {
    const user = userEvent.setup();
    const project = makeProject({
      ...BASE,
      outcome: 'shadowed',
      display_name: 'Desk B',
      shadowed_by: { path: '/w/desk-a', display_name: 'Desk A', desk_project_id: 'qA' },
    });
    renderDialog(project);

    await pasteAndSubmit(user);

    expect(await screen.findByTestId('add-helpdesk-result-shadowed')).toBeTruthy();
    // The desk that actually receives tickets has to be named, or the customer
    // believes their requests now reach the vendor they just added.
    expect(screen.getByText(/Desk A/)).toBeTruthy();
    expect(screen.queryByText(/Added to this project/)).toBeNull();
  });

  it('keeps a non-desk repo as a dependency and offers Remove rather than removing it', async () => {
    const user = userEvent.setup();
    const project = makeProject({
      ...BASE,
      outcome: 'no_manifest',
      helpdesk_id: null,
      display_name: null,
      welcome_message: null,
      desk_project_id: null,
      portal_project_id: null,
    });
    renderDialog(project);

    await pasteAndSubmit(user);

    expect(await screen.findByTestId('add-helpdesk-result-no_manifest')).toBeTruthy();
    expect(project.removeDependency).not.toHaveBeenCalled();

    const remove = screen.getByTestId('add-helpdesk-remove');
    await user.click(remove);
    // Removed by its dependency NAME — the folder on disk is left alone.
    await waitFor(() => expect(project.removeDependency).toHaveBeenCalledWith('langware-support'));

    // Nothing to open — there is no desk.
    expect(screen.queryByTestId('add-helpdesk-open')).toBeNull();
  });

  it('reports a desk that names no queue instead of calling it adopted', async () => {
    const user = userEvent.setup();
    const project = makeProject({
      ...BASE,
      outcome: 'invalid_desk_project_id',
      display_name: 'Broken Desk',
      desk_project_id: null,
      portal_project_id: null,
    });
    renderDialog(project);

    await pasteAndSubmit(user);

    expect(await screen.findByTestId('add-helpdesk-result-invalid_desk_project_id')).toBeTruthy();
    expect(screen.queryByTestId('add-helpdesk-open')).toBeNull();
  });

  it('surfaces the backend message verbatim when the attach fails', async () => {
    const user = userEvent.setup();
    const project = {
      id: 'proj-1',
      adoptHelpdeskFromGit: vi.fn(() =>
        Promise.reject({
          response: {
            data: {
              message:
                'Repository is already materialized for branch main; requested demo/cloudnsite-agents',
            },
          },
        }),
      ),
      removeDependency: vi.fn(),
    };
    renderDialog(project as unknown as ReturnType<typeof makeProject>);

    await pasteAndSubmit(user);

    // The 409 names BOTH branches; a generic "could not add" would strand the
    // user with no idea that a stale checkout is the reason.
    const err = await screen.findByTestId('add-helpdesk-error');
    expect(err.textContent).toContain('demo/cloudnsite-agents');
  });
});
