import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, Conversation, dataManager, GRAPH_API_PREFIX, Project, Task } from '@sdk';
import { applyProjectToConversation, applyProjectToTask } from '@src/components/conversation/apply-project-choice';

const ID = {
  conv: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
  previousProject: '33333333-3333-4333-8333-333333333333',
  user: '44444444-4444-4444-8444-444444444444',
};

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return new Conversation({
    id: ID.conv,
    type: Conversation.type,
    created_by: ID.user,
    remote: true,
    project_id: null,
    ...overrides,
  });
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return new Project({
    id: ID.project,
    type: Project.type,
    created_by: ID.user,
    name: 'langware-os',
    fs_storage_mount_path: '/Users/shlom/Flowpad workspace/langware-os',
    ...overrides,
  });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return new Task({
    id: '55555555-5555-4555-8555-555555555555',
    type: Task.type,
    created_by: ID.user,
    title: 'Review project choice',
    project_id: null,
    project_name: null,
    project_root: null,
    ...overrides,
  });
}

describe('applyProjectToConversation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves project_id locally without Hub-Reflect for remote conversations', async () => {
    const conv = makeConversation();
    const project = makeProject();
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(conv);
    const updateSpy = vi.spyOn(dataManager, 'updateEntityFromJson');
    const putSpy = vi.spyOn(apiClient, 'put').mockResolvedValue({
      id: ID.conv,
      type: Conversation.type,
      project_id: ID.project,
      private_context_entities: [`project-${ID.project}`],
    } as never);

    const result = await applyProjectToConversation(ID.conv, project);

    expect(result).toEqual({ saved: true, wasReplacement: false });
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0][0]).toBe(`${GRAPH_API_PREFIX}/conversation/${ID.conv}`);
    expect(putSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        id: ID.conv,
        type: Conversation.type,
        project_id: ID.project,
      }),
    );
    expect(putSpy.mock.calls[0][2]).toBeUndefined();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID.conv,
        type: Conversation.type,
        project_id: ID.project,
      }),
    );
    expect(conv.project_id).toBe(ID.project);
    expect(conv.privateContextEntities.map((typeId) => typeId.toString())).toContain(`project-${ID.project}`);
  });

  it('propagates local save failures and rolls back the cached project_id', async () => {
    const conv = makeConversation();
    const project = makeProject();
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(conv);
    vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('local update rejected'));
    const updateSpy = vi.spyOn(dataManager, 'updateEntityFromJson');

    await expect(applyProjectToConversation(ID.conv, project)).rejects.toThrow('local update rejected');

    expect(conv.project_id).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('treats an existing project_id as an idempotent no-op', async () => {
    const conv = makeConversation({ project_id: ID.previousProject });
    const project = makeProject({ id: ID.previousProject });
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(conv);
    const putSpy = vi.spyOn(apiClient, 'put');

    const result = await applyProjectToConversation(ID.conv, project);

    expect(result).toEqual({ saved: false, wasReplacement: false });
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('applyProjectToTask', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates task save failures and rolls back cached project fields', async () => {
    const task = makeTask({
      project_id: ID.previousProject,
      project_name: 'previous',
      project_root: '/previous',
    });
    const project = makeProject();
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(task);
    vi.spyOn(task, 'save').mockRejectedValue(new Error('task save rejected'));

    await expect(applyProjectToTask(task.id, project)).rejects.toThrow('task save rejected');

    expect(task.project_id).toBe(ID.previousProject);
    expect(task.project_name).toBe('previous');
    expect(task.project_root).toBe('/previous');
  });
});
