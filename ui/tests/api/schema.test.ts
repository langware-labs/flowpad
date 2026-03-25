import { dataManager } from '@sdk';
import { expect, describe, it, beforeEach, afterAll } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('schema suite', () => {
  const info = getTestSignupInfo();
  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  afterAll(async () => {});

  it('test get user schema', async () => {
    const userSchema = dataManager.getSchema('User');
    expect(userSchema).toBeDefined();
  }, 10000);
});
