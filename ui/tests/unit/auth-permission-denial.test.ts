import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import apiClient, { invalidRefreshTokenMessage } from '@sdk/client';
import { AuthManager } from '@sdk/FlowSync/auth';

describe('authenticated session after an action refusal', () => {
  afterEach(() => vi.restoreAllMocks());

  async function signedIn() {
    let rejectResponse: (error: AxiosError) => Promise<never>;
    vi.spyOn(apiClient.interceptors.response, 'use').mockImplementation((_success, failure) => {
      rejectResponse = failure!;
      return 0;
    });
    const auth = new AuthManager();
    const user = { id: '56cb3eae-77ff-5727-8d01-08fce10852e0' };
    await auth.init(user);
    return { auth, user, reject: (error: AxiosError) => rejectResponse(error) };
  }

  it.each([401, 403])('keeps the user signed in after permission denial (%s)', async (status) => {
    const { auth, user, reject } = await signedIn();
    const error = new AxiosError('Request refused');
    error.response = { status, data: { message: 'Action is not allowed for this role' } } as never;
    await expect(reject(error)).rejects.toBe(error);
    expect(auth.currentUser).toBe(user);
    expect(auth.loginStatus).toBe('logged_in');
  });

  it('still clears the session when the refresh token is explicitly rejected', async () => {
    const { auth, reject } = await signedIn();
    const error = new AxiosError('Token rejected');
    error.response = { status: 401, data: { message: invalidRefreshTokenMessage } } as never;
    await expect(reject(error)).rejects.toBe(error);
    expect(auth.currentUser).toBeNull();
    expect(auth.loginStatus).toBe('logged_out');
  });
});
