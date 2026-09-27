/**
 * U6 — a project reference in a message renders the Install project / Open
 * project chip (R11, R13, R14, R15; KTD10).
 *
 * Drives the REAL `MessageEntityChip` → `ProjectInstallChip` →
 * `useInstallSharedProjectAndOpen` chain over REAL `Project` entities. The
 * stand-ins are only the boundaries:
 *   - `useProjects` (the live lazy-asset collection) and `useEntity` (the
 *     per-TypeId fetch) — the rows the chip is stated from;
 *   - `Project.prototype.setupFromGitOrigin` — the clone, which is U5's typed
 *     failure contract (`err.code`);
 *   - `useDockNavigation` (router shortcut) and `isHubOnly` (runtime signal);
 *   - the skill-run helper `MessageEntityChip` wires for skills (irrelevant here).
 *
 * Unit tier, not `tests/react/`: the react tier's setup refuses to run without
 * a live launcher-owned backend, and nothing here needs one.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { Agent, Project, TypeId } from '@sdk';

type EntityState = { data: unknown; isLoading: boolean; notFound: boolean; isError: boolean };

const h = vi.hoisted(() => ({
  projects: undefined as unknown[] | undefined,
  projectsLoading: false,
  entityByKey: new Map<string, { data: unknown; isLoading: boolean; notFound: boolean; isError: boolean }>(),
  openDock: vi.fn(),
  hubOnly: false,
}));

vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: h.projects, isLoading: h.projectsLoading, error: null, refetch: vi.fn() }),
}));

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useEntity: (typeId: { type: string; id: string } | null) => {
      const s = typeId ? h.entityByKey.get(`${typeId.type}-${typeId.id}`) : undefined;
      return {
        data: s?.data ?? undefined,
        isLoading: s?.isLoading ?? true,
        isFetching: false,
        error: null,
        isError: s?.isError ?? false,
        isSuccess: !!s && !s.isLoading,
        notFound: s?.notFound ?? false,
        refetch: vi.fn(),
      };
    },
  };
});

vi.mock('@src/navigation/useDockNavigation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
  };
});

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hubOnly }));

vi.mock('@src/components/conversation/asset-review/useRunReceivedSkill', () => ({
  useRunSkillWithProjectPrompt: () => ({ start: vi.fn(), picker: null }),
}));

import { MessageEntityChip } from '@src/components/conversation/FlowMessageBubble';

const PID = '11111111-1111-4111-8111-111111111111';
const PROJECT_TID = new TypeId('project', PID);
const CONV = '22222222-2222-4222-8222-222222222222';

function entityState(typeId: TypeId, s: Partial<EntityState>): void {
  h.entityByKey.set(`${typeId.type}-${typeId.id}`, {
    data: undefined,
    isLoading: false,
    notFound: false,
    isError: false,
    ...s,
  });
}

function sharedRow(mount: string | null = null): Project {
  return new Project({ id: PID, name: 'Apollo', fs_storage_mount_path: mount } as Partial<Project>);
}

function chip(typeId: TypeId = PROJECT_TID) {
  return (
    <MemoryRouter>
      <MessageEntityChip typeId={typeId} conversationId={CONV} forceShow={false} />
    </MemoryRouter>
  );
}

function renderChip(typeId: TypeId = PROJECT_TID) {
  return render(chip(typeId));
}

function chipState(): string | null {
  return screen.getByTestId('project-install-chip').getAttribute('data-state');
}

describe('MessageEntityChip — project install chip', () => {
  beforeEach(() => {
    h.projects = [];
    h.projectsLoading = false;
    h.entityByKey.clear();
    h.openDock.mockReset();
    h.hubOnly = false;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('waits while the row has not arrived, then offers Install project once it arrives without a mount path', () => {
    entityState(PROJECT_TID, { isLoading: true });
    const view = renderChip();

    expect(chipState()).toBe('waiting');
    expect(screen.queryByTestId('project-install-button')).toBeNull();

    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    view.rerender(chip());

    expect(chipState()).toBe('install');
    expect(screen.getByTestId('project-install-button').textContent).toContain('Install project');
  });

  it('AE5: a row with a mount path reads Open project and navigates to the project dock', () => {
    h.projects = [sharedRow('/Users/eli/Flowpad workspace/apollo')];
    entityState(PROJECT_TID, { data: sharedRow('/Users/eli/Flowpad workspace/apollo') });
    renderChip();

    expect(chipState()).toBe('open');
    const open = screen.getByTestId('project-open-button');
    expect(open.textContent).toContain('Open project');

    fireEvent.click(open);
    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${PID}`);
  });

  it('installs on click: installing, then Open project on success', async () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    let resolveInstall!: (p: Project) => void;
    const setup = vi
      .spyOn(Project.prototype, 'setupFromGitOrigin')
      .mockImplementation(() => new Promise<Project>((r) => (resolveInstall = r)));
    renderChip();

    fireEvent.click(screen.getByTestId('project-install-button'));
    expect(chipState()).toBe('installing');
    expect(setup).toHaveBeenCalledTimes(1);

    resolveInstall(sharedRow('/Users/eli/Flowpad workspace/apollo'));

    await waitFor(() => expect(chipState()).toBe('open'));
    // The install lands URL-first in the project, like a fresh clone.
    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${PID}`);
  });

  it('AE6: REPO_NOT_ACCESSIBLE shows the repository-access message, nothing installed, retry returns to Install', async () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    vi.spyOn(Project.prototype, 'setupFromGitOrigin').mockRejectedValue(
      Object.assign(new Error('Git clone failed: Repository not found'), { code: 'REPO_NOT_ACCESSIBLE' }),
    );
    renderChip();

    fireEvent.click(screen.getByTestId('project-install-button'));

    await waitFor(() => expect(chipState()).toBe('error'));
    expect(screen.getByTestId('project-install-error').textContent).toMatch(
      /access to (this project's|the) repository/i,
    );
    expect(screen.queryByTestId('project-open-button')).toBeNull();
    expect(h.openDock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('project-install-retry'));
    expect(chipState()).toBe('install');
    expect(screen.getByTestId('project-install-button')).toBeTruthy();
  });

  it('AUTH_REQUIRED gets its own connect-GitHub message, distinct from repository access', async () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    vi.spyOn(Project.prototype, 'setupFromGitOrigin').mockRejectedValue(
      Object.assign(new Error('auth required'), { code: 'AUTH_REQUIRED' }),
    );
    renderChip();

    fireEvent.click(screen.getByTestId('project-install-button'));

    await waitFor(() => expect(chipState()).toBe('error'));
    const text = screen.getByTestId('project-install-error').textContent ?? '';
    expect(text).toMatch(/connect github/i);
    expect(text).not.toMatch(/collaborator/i);
  });

  it('an untyped failure shows generic text', async () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    vi.spyOn(Project.prototype, 'setupFromGitOrigin').mockRejectedValue(new Error('boom'));
    renderChip();

    fireEvent.click(screen.getByTestId('project-install-button'));

    await waitFor(() => expect(chipState()).toBe('error'));
    const text = screen.getByTestId('project-install-error').textContent ?? '';
    expect(text).toMatch(/could not be installed/i);
    expect(text).not.toMatch(/connect github|collaborator/i);
  });

  it('project not found for the invitee → unavailable', () => {
    entityState(PROJECT_TID, { data: null, notFound: true });
    renderChip();

    expect(chipState()).toBe('unavailable');
    expect(screen.queryByTestId('project-install-button')).toBeNull();
    expect(screen.queryByTestId('project-open-button')).toBeNull();
  });

  it('hides the install action in a hub-only runtime', () => {
    h.hubOnly = true;
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    renderChip();

    // Hub projects have no local folder: the chip still renders the project
    // (navigable), but never offers a local install.
    expect(chipState()).toBe('open');
    expect(screen.queryByTestId('project-install-button')).toBeNull();
  });

  it('AE10 (client side): a non-project reference renders the existing chip, not the install chip', () => {
    const agentTid = new TypeId(Agent.type, '33333333-3333-4333-8333-333333333333');
    entityState(agentTid, { data: new Agent({ id: agentTid.id, name: 'Helper' } as Partial<Agent>) });
    renderChip(agentTid);

    expect(screen.queryByTestId('project-install-chip')).toBeNull();
    expect(screen.queryByTestId('project-install-button')).toBeNull();
    // The existing entity chip renders the agent.
    expect(screen.getByText('Helper')).toBeTruthy();
  });
});
