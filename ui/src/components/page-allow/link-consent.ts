import { STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { DeepLinkAction } from '@src/navigation/inbound-link';
import { LAUNCH_ACTION } from '@src/pages/entry/launch-plan';
import { probePageKey } from './probe-page-key';

/**
 * What a link would DO, when that is more than going somewhere: start an agent on a project, or bring a
 * project or task down from a repository. A link that only opens a conversation, a project or the tasks
 * needs no consent. `null` means open it.
 */
export function linkDoes(params: URLSearchParams): 'launch' | 'clone' | null {
  const action = params.get('action');
  if (action === LAUNCH_ACTION) return 'launch';
  if (action !== DeepLinkAction.OPEN) return null;
  const clones = params.get('setup_git') === '1' || (params.get('git_origin') && params.get('task_id'));
  return clones ? 'clone' : null;
}

/**
 * Whether the local server stands behind this link: it asks for no key at all, or the link carries one it
 * minted. A link from outside carries none, and a server that cannot be asked answers no.
 */
export async function linkVouchedFor(params: URLSearchParams): Promise<boolean> {
  try {
    const { enforced, probed } = await probePageKey(params.get(STATE_KEY_PARAM));
    return !enforced || !!probed;
  } catch {
    return false;
  }
}
