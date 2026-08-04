import { ActionInfo, dataContext, dataManager } from '@sdk';

/**
 * Whether the current local user has a GitHub credential.
 *
 * `null` means the question could not be answered yet, so callers can keep
 * bootstrap/network uncertainty distinct from a confirmed missing grant.
 */
export async function fetchGithubStatus(): Promise<boolean | null> {
  const userTypeId = dataContext.userTypeId;
  if (!userTypeId?.id) return null;

  try {
    const info = new ActionInfo('oauth', userTypeId.type, userTypeId.id, 'GET');
    info.subpath = 'github/status';
    const result = await dataManager.callAction<unknown, { has_token?: boolean }>(info);
    return Boolean(result?.has_token);
  } catch {
    return null;
  }
}
