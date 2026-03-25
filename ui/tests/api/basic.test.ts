import { apiStats, dataManager, Bookmark, ExpansionRequest, User, dataContext } from '@sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('basic api suite', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  afterAll(async () => {});

  it('test bootstrap returns local user', async () => {
    // In zero-auth minihub, the @local user is returned by bootstrap
    const bootstrapUser = dataContext.bootstrapInfo?.user;
    expect(bootstrapUser).toBeTruthy();
    const u: User | null = await User.getById(bootstrapUser!.id);
    expect(u).toBeTruthy();
    expect(u!.id).equal(bootstrapUser!.id);
  }, 10000);

  it('test create and get counters', async () => {
    const bookmark = new Bookmark({ title: 'Test Bookmark' });
    const initialStats = apiStats.clone();
    const created = await bookmark.save();
    expect(created).toBeTruthy();
    expect(apiStats.delta(initialStats).totalSuccessfulRequests).eq(1);
    const updated = await bookmark.save();
    expect(apiStats.delta(initialStats).totalSuccessfulRequests).eq(2);
    expect(apiStats.delta(initialStats).totalFailedRequests).eq(0);
    expect(updated).toBeTruthy();
  }, 10000);

  it('test create and get', async () => {
    const bookmark_title = `test-bookmark-${Date.now()}`;
    const bookmark: Bookmark = new Bookmark({
      title: bookmark_title,
    });
    const created = await bookmark.save();
    expect(created).toBeTruthy();
    await dataManager.clearCache();
    const fetched = await dataManager.getByTypeId(created.typeId);
    expect(fetched).toBeTruthy();
  }, 10000);

  it('test create and get permissions', async () => {
    const bookmark_title = `test-bookmark-perm-${Date.now()}`;
    const bookmark: Bookmark = new Bookmark({
      title: bookmark_title,
    });
    const created = await bookmark.save();
    expect(created).toBeTruthy();
    await dataManager.clearCache();
    const fetched = await dataManager.getByTypeId(created.typeId, new ExpansionRequest({ expand: ['permissions'] }));
    expect(fetched).toBeTruthy();
    expect(fetched?.expansions).toContain('permissions');
    expect(fetched?.expand?.roles).toBeTruthy();
    expect(fetched?.expand?.allowed_actions).toBeTruthy();
  }, 10000);
});
