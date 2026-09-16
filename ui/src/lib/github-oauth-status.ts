import { useEffect, useState } from 'react';
import { ActionInfo, OAUTH_PROVIDERS, OAuthStatus, dataContext, dataManager } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';

/** How long to wait before re-asking while the answer is still unknowable.
 *  Unchanged from the copies this hook replaces — a dedup, not a new budget. */
const BOOTSTRAP_RETRY_MS = 500;

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

/**
 * `fetchGithubStatus` as a hook, with the bootstrap retry every dialog needs.
 *
 * `fetchGithubStatus` answers `null` until `dataContext.userTypeId` lands, which
 * races any dialog opened at boot — so a single probe latches "disconnected" for
 * a user who is connected. Every git dialog had grown its own copy of the same
 * `poll()`/`setTimeout`/`cancelled` chain to work around that, and the copies had
 * already drifted on what to do with `null`. This is that loop, once.
 *
 * Re-probes whenever a GitHub grant lands, so connecting from inside the dialog
 * flips the answer without a reopen.
 */
export function useGithubConnected(enabled = true): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      const status = await fetchGithubStatus();
      if (cancelled) return;
      if (status === null) {
        setTimeout(() => {
          if (!cancelled) void poll();
        }, BOOTSTRAP_RETRY_MS);
        return;
      }
      setConnected(status);
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (msg) => {
      if (msg.status !== OAuthStatus.SUCCESS) return;
      void fetchGithubStatus().then((status) => setConnected(status ?? false));
    },
    enabled,
  );

  return connected;
}
