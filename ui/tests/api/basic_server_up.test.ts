import { config } from '@sdk';
import { beforeEach, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  await apiTestSetup(signupInfo, context.task.name);
});

it('server is up', async () => {
  try {
    const healthUrl = `${config.SERVER_URL.replace('/api/v1', '')}${config.API_PREFIXES.health}`;
    const response = await fetch(healthUrl);
    if (!response.ok) {
      throw new Error(`Health endpoint returned ${response.status}`);
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`server is down: ${errorMsg}`);
    throw new Error('server is down.');
  }
});
