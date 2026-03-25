import { dataManager } from '@sdk';
import { hasGitHubRepoAccess } from '@src/utils/gitUtils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('hasGitHubRepoAccess', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns access and default branch for public repository response', async () => {
    const callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      success: true,
      status_code: 200,
      data: { default_branch: 'main' },
    } as any);

    const result = await hasGitHubRepoAccess('https://github.com/your-org/Test_public.git');

    expect(result).toEqual({ hasAccess: true, defaultBranch: 'main' });
    expect(callActionSpy).toHaveBeenCalledTimes(1);

    const actionInfo = callActionSpy.mock.calls[0][0];
    expect(actionInfo.name).toBe('proxy');
    expect(actionInfo.method).toBe('POST');
    expect(actionInfo.bodyParameters).toMatchObject({
      method: 'GET',
      url: 'https://api.github.com/repos/your-org/Test_public',
    });
  });

  it('returns no access for private or missing repository (404)', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      success: false,
      status_code: 404,
      data: { message: 'Not Found' },
    } as any);

    const result = await hasGitHubRepoAccess('https://github.com/your-org/Test_private.git');

    expect(result).toEqual({ hasAccess: false, defaultBranch: null });
  });

  it('returns null when GitHub API is rate limited', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      success: false,
      status_code: 403,
      headers: { 'X-RateLimit-Remaining': '0' },
      data: { message: 'API rate limit exceeded' },
    } as any);

    const result = await hasGitHubRepoAccess('https://github.com/your-org/Test_public.git');

    expect(result).toBeNull();
  });
});
