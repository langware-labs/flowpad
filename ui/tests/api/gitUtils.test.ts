import apiClient from '@sdk/client';
import { hasGitHubRepoAccess } from '@src/utils/gitUtils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('hasGitHubRepoAccess', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns access and default branch for public repository response', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValue({
      accessible: true,
      default_branch: 'main',
    } as never);

    const gitUrl = 'https://github.com/your-org/Test_public.git';
    const result = await hasGitHubRepoAccess(gitUrl);

    expect(result).toEqual({ hasAccess: true, defaultBranch: 'main' });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('/api/v1/git/remote-access', {
      clone_url: gitUrl,
    });
  });

  it('returns no access when the remote is inaccessible', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({
      accessible: false,
      default_branch: null,
    } as never);

    const result = await hasGitHubRepoAccess('https://github.com/your-org/Test_private.git');

    expect(result).toEqual({ hasAccess: false, defaultBranch: null });
  });

  it('returns null when the backend request fails', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('backend unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await hasGitHubRepoAccess('https://github.com/your-org/Test_public.git');
    errorSpy.mockRestore();

    expect(result).toBeNull();
  });
});
