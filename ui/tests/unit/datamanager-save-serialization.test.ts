/**
 * Deterministic regressions for per-entity save ordering.
 *
 * The HTTP promises are explicitly controlled: no clocks, polling, retries,
 * or widened test budgets. These tests fail if a queued save reads the shared
 * entity late, if two PUTs overlap, or if a WS update unlocks an active save.
 */
import { dataManager, EntityStatus, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = '91a487bf-d598-4b64-b2e7-19b3d745e7cd';
const USER_ID = '6e23d813-362e-47f5-af54-30851d3ace52';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function projectJson(lastMode: string, extra: Record<string, unknown> = {}) {
  return {
    type: Project.type,
    id: PROJECT_ID,
    created_by: USER_ID,
    name: 'save-serialization',
    last_mode: lastMode,
    ...extra,
  };
}

function makeProject(lastMode = 'dev'): Project {
  return new Project(projectJson(lastMode));
}

interface TestEntityRef {
  status: EntityStatus;
  saveInFlight: boolean;
  pendingUpdate: Record<string, unknown> | null;
}

const managerInternals = dataManager as unknown as {
  onDataOp: (typeId: string, operation: 'update', data: Record<string, unknown>) => void;
  getRef: (typeId: TypeId) => TestEntityRef;
};

function fireUpdate(data: Record<string, unknown>): void {
  managerInternals.onDataOp(`project-${PROJECT_ID}`, 'update', {
    type: Project.type,
    id: PROJECT_ID,
    ...data,
  });
}

describe('DataManager per-entity save serialization', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  afterEach(() => vi.restoreAllMocks());

  it('preserves each save-call payload and never overlaps PUTs', async () => {
    const project = makeProject('dev');
    const firstResponse = deferred<ReturnType<typeof projectJson>>();
    const secondResponse = deferred<ReturnType<typeof projectJson>>();
    const responses = [firstResponse, secondResponse];
    let activeRequests = 0;
    let maxActiveRequests = 0;

    const putSpy = vi.spyOn(apiClient, 'put').mockImplementation(() => {
      const response = responses[putSpy.mock.calls.length - 1];
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return response.promise.finally(() => {
        activeRequests -= 1;
      }) as unknown as ReturnType<typeof apiClient.put>;
    });

    const firstSave = project.save();
    await Promise.resolve();
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0][1]).toEqual(expect.objectContaining({ last_mode: 'dev' }));

    project.last_mode = 'vibe';
    const secondSave = project.save();
    // Mutations after the call, including the older response below, must not
    // change the already-captured second payload.
    project.last_mode = 'advanced';
    // A self/peer notification during the first request must not mark the ref
    // READY and release the queued second PUT.
    fireUpdate({ last_mode: 'ws-during-first' });
    await Promise.resolve();
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(managerInternals.getRef(project.typeId).status).toBe(EntityStatus.FETCHING);

    firstResponse.resolve(projectJson('dev-response'));
    await firstSave;
    await Promise.resolve();

    expect(putSpy).toHaveBeenCalledTimes(2);
    expect(putSpy.mock.calls[1][1]).toEqual(expect.objectContaining({ last_mode: 'vibe' }));
    expect(maxActiveRequests).toBe(1);

    secondResponse.resolve(projectJson('vibe'));
    await secondSave;
    expect(project.last_mode).toBe('vibe');
    expect(maxActiveRequests).toBe(1);
  });

  it('buffers and merges DataOps until the active save completes', async () => {
    const project = makeProject('dev');
    const response = deferred<ReturnType<typeof projectJson>>();
    vi.spyOn(apiClient, 'put').mockReturnValue(response.promise as unknown as ReturnType<typeof apiClient.put>);

    const save = project.save();
    await Promise.resolve();

    const ref = managerInternals.getRef(project.typeId);
    expect(ref.status).toBe(EntityStatus.FETCHING);
    expect(ref.saveInFlight).toBe(true);

    fireUpdate({ last_mode: 'ws-newer' });
    fireUpdate({ name: 'renamed-by-ws' });

    // The WS messages neither mutate nor unlock the ref while HTTP owns it.
    expect(ref.status).toBe(EntityStatus.FETCHING);
    expect(project.last_mode).toBe('dev');
    expect(ref.pendingUpdate).toEqual(expect.objectContaining({ last_mode: 'ws-newer', name: 'renamed-by-ws' }));

    response.resolve(projectJson('http-older'));
    await save;

    expect(ref.status).toBe(EntityStatus.READY);
    expect(ref.saveInFlight).toBe(false);
    expect(ref.pendingUpdate).toBeNull();
    expect(project.last_mode).toBe('ws-newer');
    expect(project.name).toBe('renamed-by-ws');
  });
});
