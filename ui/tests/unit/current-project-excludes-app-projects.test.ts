import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSdkMainRealm, disposeAllOwnedSdkRealms, type OwnedSdkMainRealm } from '../_sdk_realm';

/**
 * A project the backend marks `hidden` (the Flowpad Assistant, a help-desk
 * portal checkout, the agent mount root) is a place you VISIT.
 * Opening one must never move the current project — the footer chip, the nav
 * chip and every project-scoped action keep pointing where the user was.
 */

let realm: OwnedSdkMainRealm;
let activate: ReturnType<typeof vi.spyOn>;
const workProjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const appProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(async () => {
  localStorage.clear();
  realm = await createSdkMainRealm('http://unit-tier-has-no-backend.invalid:80');
  const { sdk } = realm;
  activate = vi.spyOn(sdk.Project, 'activateById').mockResolvedValue(undefined as never);
  const user = new sdk.User({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  user.markAsExpanded();
  await sdk.dataContext.setContextEntityTypeId(sdk.ContextEntitiesEnum.LocalUserTypeId, user.typeId);
});
afterEach(() => {
  disposeAllOwnedSdkRealms();
  vi.restoreAllMocks();
});

/** Cache a project so the context write resolves it without a fetch. */
function cache(fields: { id: string; name?: string; hidden?: boolean }) {
  const project = new realm.sdk.Project(fields);
  project.markAsExpanded();
  return project;
}

async function enterWorkProject() {
  const work = cache({ id: workProjectId, name: 'My work' });
  await realm.sdk.dataContext.setContextEntityTypeId(realm.sdk.ContextEntitiesEnum.CurrentProjectTypeId, work.typeId);
  expect(realm.sdk.dataContext.project?.id).toBe(workProjectId);
}

describe('the current project never becomes an app-managed project', () => {
  it('keeps the previous project when opening one', async () => {
    await enterWorkProject();
    const app = cache({ id: appProjectId, hidden: true });
    await realm.sdk.dataContext.setContextEntityTypeId(realm.sdk.ContextEntitiesEnum.CurrentProjectTypeId, app.typeId);
    expect(realm.sdk.dataContext.project?.id).toBe(workProjectId);
  });

  it('does not stamp open-recency on a rejected project', async () => {
    const app = cache({ id: appProjectId, hidden: true });
    await realm.sdk.dataContext.setContextEntityTypeId(realm.sdk.ContextEntitiesEnum.CurrentProjectTypeId, app.typeId);
    expect(realm.sdk.dataContext.project).toBeNull();
    expect(activate).not.toHaveBeenCalled();
  });

  it('does not remember one across a restart', async () => {
    const { setContextEntityToLocalStorage } = await import('@sdk/FlowSync/context-local-storage');
    setContextEntityToLocalStorage(
      realm.sdk.ContextEntitiesEnum.CurrentProjectTypeId,
      new realm.sdk.TypeId('project', appProjectId),
    );
    cache({ id: appProjectId, hidden: true });
    realm.sdk.dataContext.bootstrapInfo = { default_project: { id: workProjectId } };
    cache({ id: workProjectId, name: 'My work' });
    await realm.sdk.dataContext.setupProject();
    expect(realm.sdk.dataContext.project?.id).toBe(workProjectId);
  });

  it('keeps the flag when the entity is built from a payload', () => {
    // Project's constructor assigns each field EXPLICITLY, because a class
    // field initializer runs after super() and would otherwise reset it. A
    // field left out of that list silently reads as its default — here that
    // means every hidden project looks ordinary and the guard never fires.
    expect(new realm.sdk.Project({ id: appProjectId, hidden: true }).hidden).toBe(true);
  });

  it('still switches to an ordinary project', async () => {
    await enterWorkProject();
    const other = cache({ id: appProjectId, name: 'Another project' });
    await realm.sdk.dataContext.setContextEntityTypeId(
      realm.sdk.ContextEntitiesEnum.CurrentProjectTypeId,
      other.typeId,
    );
    expect(realm.sdk.dataContext.project?.id).toBe(appProjectId);
  });
});
