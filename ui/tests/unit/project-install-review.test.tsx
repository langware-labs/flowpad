/**
 * U6 — a project reference in a message is the generic entity chip: dashed
 * until the project is installed here, opening the review popup, whose
 * project branch offers Install project in place of Install in project /
 * Install global (R11, R13, R15; KTD10).
 *
 * Drives the REAL `MessageEntityChip` → `AssetReviewDialog` →
 * `ProjectInstallAction` → `useInstallSharedProjectAndOpen` chain over REAL
 * `Project` entities. The stand-ins are only the boundaries:
 *   - `useProjects` (the live lazy-asset collection) and `useEntity` (the
 *     per-TypeId fetch) — the rows the chip is stated from;
 *   - `Project.prototype.setupFromGitOrigin` — the clone;
 *   - `useDockNavigation` (router shortcut) and `isHubOnly` (runtime signal);
 *   - the skill-run helper `MessageEntityChip` wires for skills (irrelevant here).
 *
 * Unit tier, not `tests/react/`: the react tier's setup refuses to run without
 * a live launcher-owned backend, and nothing here needs one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  advanced: false,
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

// No importOriginal: loading the real module pulls the asset-review components
// back in mid-factory, and they would bind the real hook instead of this one.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hubOnly }));

vi.mock('@src/contexts/view-mode-context', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useIsAdvanced: () => h.advanced };
});

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
  return screen.getByTestId('project-chip').getAttribute('data-state');
}

function actionState(): string | null {
  return screen.getByTestId('project-install-action').getAttribute('data-state');
}

/** Click the dashed chip: the review popup opens on the project branch. */
function openReview(): void {
  fireEvent.click(within(screen.getByTestId('project-chip')).getByRole('button'));
  expect(screen.getByTestId('asset-review-dialog')).toBeTruthy();
}

describe('MessageEntityChip — project reference', () => {
  beforeEach(() => {
    h.projects = [];
    h.projectsLoading = false;
    h.entityByKey.clear();
    h.openDock.mockReset();
    h.hubOnly = false;
    h.advanced = false;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('not installed: a dashed chip whose popup offers Install project, not the scope pair', () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    renderChip();

    expect(chipState()).toBe('staged');
    expect(screen.getByText('Apollo')).toBeTruthy();
    openReview();

    expect(actionState()).toBe('install');
    expect(screen.getByTestId('project-install-button').textContent).toContain('Install project');
    expect(screen.queryByTestId('asset-install-project')).toBeNull();
    expect(screen.queryByTestId('asset-install-global')).toBeNull();
  });

  it('the popup previews the project: its name and the git URL it clones', () => {
    const row = new Project({
      id: PID,
      name: 'Apollo',
      fs_storage_mount_path: null,
      origin: { kind: 'git', provider: 'github', owner: 'acme', name: 'apollo', branch: 'main', rel_path: '' },
    } as Partial<Project>);
    h.projects = [row];
    entityState(PROJECT_TID, { data: row });
    renderChip();
    openReview();

    expect(screen.getByTestId('project-preview-name').textContent).toBe('Apollo');
    expect(screen.getByTestId('project-preview-git-url').textContent).toBe('https://github.com/acme/apollo.git');
  });

  it('a git-backed project (it has an origin) labels the install Clone & Open', () => {
    const row = new Project({
      id: PID,
      name: 'Apollo',
      fs_storage_mount_path: null,
      origin: { kind: 'git', provider: 'github', owner: 'acme', name: 'apollo', branch: 'main', rel_path: '' },
    } as unknown as Partial<Project>);
    h.projects = [row];
    entityState(PROJECT_TID, { data: row });
    renderChip();
    openReview();

    expect(actionState()).toBe('install');
    expect(screen.getByTestId('project-install-button').textContent).toContain('Clone & Open');
  });

  it('waits in the popup while the row has not arrived, then offers Install project', () => {
    entityState(PROJECT_TID, { isLoading: true });
    const view = renderChip();
    openReview();

    expect(actionState()).toBe('waiting');
    expect(screen.queryByTestId('project-install-button')).toBeNull();

    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    view.rerender(chip());

    expect(actionState()).toBe('install');
  });

  it.each([
    ['Standard / Vibe', false],
    ['Advanced', true],
  ])('AE5 (%s): an installed project reopens the popup — preview, greyed install, Open', (_mode, advanced) => {
    h.advanced = advanced;
    h.projects = [sharedRow('/Users/eli/Flowpad workspace/apollo')];
    entityState(PROJECT_TID, { data: sharedRow('/Users/eli/Flowpad workspace/apollo') });
    renderChip();

    expect(chipState()).toBe('installed');
    openReview();
    expect(actionState()).toBe('open');
    expect(screen.getByTestId('project-preview')).toBeTruthy();
    expect((screen.getByTestId('project-install-button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('asset-open-entity'));
    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${PID}`);
  });

  it('installs from the popup: installing, then lands in the project and closes', async () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    let resolveInstall!: (p: Project) => void;
    const setup = vi
      .spyOn(Project.prototype, 'setupFromGitOrigin')
      .mockImplementation(() => new Promise<Project>((r) => (resolveInstall = r)));
    renderChip();
    openReview();

    fireEvent.click(screen.getByTestId('project-install-button'));
    expect(actionState()).toBe('installing');
    expect(setup).toHaveBeenCalledTimes(1);

    resolveInstall(sharedRow('/Users/eli/Flowpad workspace/apollo'));

    // The install lands URL-first in the project, like a fresh clone.
    await waitFor(() => expect(h.openDock).toHaveBeenCalledTimes(1));
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${PID}`);
    await waitFor(() => expect(screen.queryByTestId('asset-review-dialog')).toBeNull());
  });

  it('a failed install shows the error, installs nothing, and retry returns to Install', async () => {
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    vi.spyOn(Project.prototype, 'setupFromGitOrigin').mockRejectedValue(
      new Error('Git clone failed: Repository not found'),
    );
    renderChip();
    openReview();

    fireEvent.click(screen.getByTestId('project-install-button'));

    await waitFor(() => expect(actionState()).toBe('error'));
    expect(screen.getByTestId('project-install-error').textContent).toMatch(/could not be installed/i);
    expect(h.openDock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('project-install-retry'));
    expect(actionState()).toBe('install');
  });

  it('project not found for the invitee → the popup says unavailable', () => {
    entityState(PROJECT_TID, { data: null, notFound: true });
    renderChip();
    openReview();

    expect(actionState()).toBe('unavailable');
    expect(screen.queryByTestId('project-install-button')).toBeNull();
  });

  it('a hub-only runtime never installs: the project counts as installed and opens', () => {
    h.hubOnly = true;
    h.projects = [sharedRow(null)];
    entityState(PROJECT_TID, { data: sharedRow(null) });
    renderChip();

    expect(chipState()).toBe('installed');
    expect(screen.queryByTestId('project-install-button')).toBeNull();
  });

  it('AE10 (client side): a non-project reference renders the existing chip, not the project chip', () => {
    const agentTid = new TypeId(Agent.type, '33333333-3333-4333-8333-333333333333');
    entityState(agentTid, { data: new Agent({ id: agentTid.id, name: 'Helper' } as Partial<Agent>) });
    renderChip(agentTid);

    expect(screen.queryByTestId('project-chip')).toBeNull();
    // The existing entity chip renders the agent.
    expect(screen.getByText('Helper')).toBeTruthy();
  });
});
