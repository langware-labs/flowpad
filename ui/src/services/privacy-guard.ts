/**
 * The single front-end gate for cloud-touching actions (login, share).
 *
 * Every UI call site that would reach the cloud funnels through
 * `guardCloudAction(...)`. When the instance is in Local (private) data-privacy
 * mode it returns `false` and raises the one standardized notification for that
 * action — so the validation + copy live in exactly one place. The backend
 * enforces the same rule independently (defense in depth).
 *
 * Copy here is kept in sync with the backend constants
 * (`LOCAL_MODE_LOGIN_MESSAGE` / `LOCAL_MODE_SHARE_MESSAGE`).
 */

import { privacyManager } from '@sdk';
import { notify } from '../notifications/notify';

export type CloudAction = 'login' | 'share';

const LOCAL_MODE_MESSAGE: Record<CloudAction, string> = {
  login: 'Login disabled in Local mode',
  share: 'Sharing disabled in Local mode',
};

/**
 * Returns `true` when the action may proceed, `false` (and notifies) when the
 * instance is in Local mode.
 */
export function guardCloudAction(action: CloudAction): boolean {
  if (!privacyManager.isLocal) return true;
  notify.warning({ title: LOCAL_MODE_MESSAGE[action] });
  return false;
}
