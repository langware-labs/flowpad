import { PageId, ViewType, isHubOnly } from '@sdk';
import type { NavigationActions } from '@src/navigation/NavigationActions';

/** Open the Inbound screen on the page this app serves: the hub page on the hub, the desk on a desktop. */
export function openInbound(navigation: Pick<NavigationActions, 'openPage'>): void {
  navigation.openPage(isHubOnly() ? PageId.HUB : PageId.DESK, ViewType.INBOUND);
}
