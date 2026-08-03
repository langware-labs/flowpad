import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dialogMocks = vi.hoisted(() => ({
  project: null as import('@sdk').Project | null,
  projects: [] as Array<{ cwd: string }>,
  openDock: vi.fn(),
  commit: vi.fn(),
  restore: vi.fn(() => Promise.resolve()),
  ensureProject: vi.fn(),
}));

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return { ...actual, useProject: () => ({ project: dialogMocks.project }) };
});

vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: null }),
}));

vi.mock('@src/hooks/use-all-projects', () => ({
  useAllProjects: () => ({ projects: dialogMocks.projects, isLoading: false }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: dialogMocks.openDock } }),
}));

vi.mock('@src/components/quick-create/useProjectSnapshot', () => ({
  useProjectSnapshot: () => ({ commit: dialogMocks.commit, restore: dialogMocks.restore }),
}));

vi.mock('@src/components/project-selector', () => ({
  canonicalPath: (value: string) => value,
  NewProjectDialog: () => null,
  ProjectSelectorModal: (props: { open: boolean; onSelect: (id: string) => void }) =>
    props.open ? <button onClick={() => props.onSelect('/project-b')}>Pick project B</button> : null,
  projectListToSelectorItems: () => [],
  useEnsureProject: () => dialogMocks.ensureProject,
}));

import { Agent, ContextEntitiesEnum, dataContext, Project, type TypeId } from '@sdk';
import { ScopeSelection, type Scope } from '@src/components/quick-create/ScopeSelection';
import { QuickCreateDialog } from '@src/components/quick-create/QuickCreateDialog';
import { getDescriptor } from '@src/components/quick-create/registry';

const AGENT_ID = '38ee7347-04ab-4b88-bc29-5b5d1ee412a5';
const PROJECT_ID = '2bb0cf90-157a-4ba7-9c1c-99c0ddeedb6d';

afterEach(() => {
  cleanup();
  dialogMocks.project = null;
  dialogMocks.projects = [];
  dialogMocks.ensureProject.mockReset();
  runInAction(() => {
    (
      dataContext as unknown as {
        _contextEntitiesMap: Map<ContextEntitiesEnum, TypeId | null | undefined>;
      }
    )._contextEntitiesMap.set(ContextEntitiesEnum.CurrentProjectTypeId, null);
  });
  vi.restoreAllMocks();
});

function createArgs(project: Project | null, scope: 'user' | 'project' | 'folder') {
  return {
    project,
    name: ' Q ',
    absolutePath: 'flowpad-os/agentic-assets/agent',
    scope,
    harness: 'all' as const,
    folderVfsPath: 'agentic-assets/agent',
  };
}

describe('Agent Quick Create', () => {
  it('creates through the selected project and returns a stable TypeId pointer', async () => {
    const project = new Project({ id: PROJECT_ID, name: 'flowpad-os' });
    const saved = new Agent({ id: AGENT_ID, name: 'Q' });
    const create = vi.spyOn(Agent, 'createInProject').mockResolvedValue(saved);
    const descriptor = getDescriptor(Agent.type)!;

    const result = await descriptor.create(createArgs(project, 'project'));

    expect(descriptor.allowedScopes).toEqual(['user', 'project']);
    expect(create).toHaveBeenCalledWith(project, ' Q ', 'agentic-assets/agent');
    expect(result.toastTitle).toBe('Agent created');
    expect(result.pointer?.toUrl()).toContain(`typeid/agent-${AGENT_ID}`);
  });

  it('passes null for User scope and rejects Folder scope before creating', async () => {
    const saved = new Agent({ id: AGENT_ID, name: 'Q' });
    const create = vi.spyOn(Agent, 'createInProject').mockResolvedValue(saved);
    const descriptor = getDescriptor(Agent.type)!;

    await descriptor.create(createArgs(null, 'user'));
    expect(create).toHaveBeenLastCalledWith(null, ' Q ', 'agentic-assets/agent');

    await expect(descriptor.create(createArgs(null, 'folder'))).rejects.toThrow(/User or Project/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('uses the selected User scope even when an ambient project exists', async () => {
    const ambient = new Project({ id: PROJECT_ID, name: 'ambient-project' });
    dialogMocks.project = ambient;
    const contextMap = (
      dataContext as unknown as {
        _contextEntitiesMap: Map<ContextEntitiesEnum, TypeId | null | undefined>;
      }
    )._contextEntitiesMap;
    runInAction(() => contextMap.set(ContextEntitiesEnum.CurrentProjectTypeId, ambient.typeId));
    const saved = new Agent({ id: AGENT_ID, name: 'Q' });
    const create = vi.spyOn(Agent, 'createInProject').mockResolvedValue(saved);

    render(<QuickCreateDialog open onOpenChange={vi.fn()} type="agent" />);
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    fireEvent.change(screen.getByPlaceholderText('New agent name'), { target: { value: 'Q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(null, 'Q', undefined);
    runInAction(() => contextMap.set(ContextEntitiesEnum.CurrentProjectTypeId, null));
  });

  it('keeps a picked Project local until creation and creates in that Project', async () => {
    const ambient = new Project({
      id: PROJECT_ID,
      name: 'project-a',
      fs_storage_mount_path: '/project-a',
    });
    const selected = new Project({
      id: 'e58d0362-3bce-4862-aa34-1902adbbf077',
      name: 'project-b',
      fs_storage_mount_path: '/project-b',
    });
    dialogMocks.project = ambient;
    dialogMocks.projects = [{ cwd: '/project-b' }];
    dialogMocks.ensureProject.mockResolvedValue(selected);
    const saved = new Agent({ id: AGENT_ID, name: 'Q' });
    const create = vi.spyOn(Agent, 'createInProject').mockResolvedValue(saved);

    render(<QuickCreateDialog open onOpenChange={vi.fn()} type="agent" />);
    fireEvent.click(screen.getByRole('button', { name: 'project-a' }));
    fireEvent.click(screen.getByText('Pick project B'));
    await screen.findByRole('button', { name: 'project-b' });
    fireEvent.change(screen.getByPlaceholderText('New agent name'), { target: { value: 'Q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(dialogMocks.ensureProject).toHaveBeenCalledWith('/project-b', { select: false });
    expect(create).toHaveBeenCalledWith(selected, 'Q', 'agentic-assets/agent');
    expect(dialogMocks.openDock).toHaveBeenCalledTimes(1);
  });

  it('shows only User and Project scope chips for Agent', () => {
    const scope: Scope = { kind: 'user', project: null, folderPath: null };
    render(
      <ScopeSelection
        scope={scope}
        onScopeChange={vi.fn()}
        harness="all"
        onHarnessChange={vi.fn()}
        path="~/agentic-assets/agent"
        onPathChange={vi.fn()}
        onPickFolder={vi.fn(() => Promise.resolve(null))}
        onOpenProjectPicker={vi.fn()}
        allowedScopes={['user', 'project']}
      />,
    );

    expect(screen.getByRole('button', { name: 'User' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Folder' })).not.toBeInTheDocument();
  });

  it('trims Agent names and delegates scope persistence to the entity save seam', async () => {
    const project = new Project({ id: PROJECT_ID });
    const save = vi.spyOn(Agent.prototype, 'save').mockImplementation(function () {
      return Promise.resolve(this);
    });

    const agent = await Agent.createInProject(project, '  Q  ');

    expect(agent.name).toBe('Q');
    expect(save).toHaveBeenCalledWith([project.typeId]);
  });

  it('resolves only the canonical sibling avatar inside an agent.md bundle', () => {
    const agent = new Agent({
      id: AGENT_ID,
      asset_ref: '/workspace/agentic-assets/agent/q/agent.md',
      avatar: './avatar.png',
    });
    expect(agent.bundleDirectory).toBe('/workspace/agentic-assets/agent/q');
    expect(agent.avatarAssetRef).toBe('/workspace/agentic-assets/agent/q/avatar.png');

    agent.avatar = '../avatar.png';
    expect(agent.avatarAssetRef).toBeNull();
  });
});
