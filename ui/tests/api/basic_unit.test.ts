import { User } from '@sdk';
import { afterAll, beforeEach, describe, expect, it, TestContext } from 'vitest';
import { apiTestSetup, getTestSignupInfo, noop } from '../utils/test-utils';

describe('basic unit test ', () => {
  const info = getTestSignupInfo();
  let user: User | null = null;
  beforeEach(async (context: unknown) => {
    const testContext = context as TestContext;
    user = await apiTestSetup(info, testContext.task.name);
    noop(user);
  });

  afterAll(async () => {});

  //just simple empty test
  it('test empty', async () => {
    expect(true).toBeTruthy();
  }, 15000);
});
