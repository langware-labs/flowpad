import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSdkMainRealm, disposeAllOwnedSdkRealms, type OwnedSdkMainRealm } from '../_sdk_realm';

let realm: OwnedSdkMainRealm;
const rememberedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const defaultId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(async () => {
  localStorage.clear();
  realm = await createSdkMainRealm('http://unit-tier-has-no-backend.invalid:80');
  const { sdk } = realm;
  vi.spyOn(sdk.Project, 'activateById').mockResolvedValue(undefined as never);
  const user = new sdk.User({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  user.markAsExpanded();
  await sdk.dataContext.setContextEntityTypeId(sdk.ContextEntitiesEnum.LocalUserTypeId, user.typeId);
  const project = new sdk.Project({ id: defaultId });
  project.markAsExpanded();
  sdk.dataContext.bootstrapInfo = { default_project: { id: defaultId } };
});
afterEach(() => { disposeAllOwnedSdkRealms(); vi.restoreAllMocks(); });

async function remember() {
  const { setContextEntityToLocalStorage } = await import('@sdk/FlowSync/context-local-storage');
  setContextEntityToLocalStorage(realm.sdk.ContextEntitiesEnum.CurrentProjectTypeId, new realm.sdk.TypeId('project', rememberedId));
}

describe('route-owned remembered project fallback', () => {
  it('uses the cached server default with no collection or entity fetch', async () => {
    const fetch = vi.spyOn(realm.sdk.dataManager, 'fetchByTypeId');
    const query = vi.spyOn(realm.sdk.Project, 'query');
    await realm.sdk.dataContext.setupProject();
    expect(realm.sdk.dataContext.project?.id).toBe(defaultId);
    expect(fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves browser memory by ID and prefers it over the server default', async () => {
    await remember();
    const project = new realm.sdk.Project({ id: rememberedId });
    project.markAsExpanded();
    const query = vi.spyOn(realm.sdk.Project, 'query');
    await realm.sdk.dataContext.setupProject();
    expect(realm.sdk.dataContext.project?.id).toBe(rememberedId);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([403, 404])('falls back for an inaccessible remembered project (%s)', async status => {
    await remember();
    const fetch = vi.spyOn(realm.sdk.dataManager, 'fetchByTypeId').mockRejectedValue({ status });
    await realm.sdk.dataContext.setupProject();
    expect(realm.sdk.dataContext.project?.id).toBe(defaultId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].id).toBe(rememberedId);
  });

  it('preserves transient errors instead of selecting another project', async () => {
    await remember();
    vi.spyOn(realm.sdk.dataManager, 'fetchByTypeId').mockRejectedValue({ status: 503 });
    await expect(realm.sdk.dataContext.setupProject()).rejects.toEqual({ status: 503 });
    expect(realm.sdk.dataContext.project).toBeNull();
  });
});

it('does not let lazy workspace discovery undo a selection made while it was pending', async () => {
  const { sdk } = realm;
  let resolve!: (rows: InstanceType<typeof sdk.Workspace>[]) => void;
  const pending = new Promise<InstanceType<typeof sdk.Workspace>[]>(done => { resolve = done; });
  vi.spyOn(sdk.dataContext, 'getUserWorkspaces').mockReturnValue(pending);
  const discovering = sdk.dataContext.setupWorkspace();
  const chosen = new sdk.Workspace({ id: rememberedId });
  chosen.markAsExpanded();
  await sdk.dataContext.setContextEntityTypeId(sdk.ContextEntitiesEnum.CurrentWorkspaceTypeId, chosen.typeId);
  const old = new sdk.Workspace({ id: defaultId });
  old.markAsExpanded();
  resolve([old]);
  await discovering;
  expect(sdk.dataContext.workspace?.id).toBe(rememberedId);
});
