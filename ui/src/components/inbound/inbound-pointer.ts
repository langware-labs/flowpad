import { ViewType } from '@sdk';
import { servedPage } from '@src/lib/hub-page-url';
import type { NavigationActions } from '@src/navigation/NavigationActions';

/** Open the Inbound screen on the page this app serves: the hub page on the hub, the desk on a desktop. */
export function openInbound(navigation: Pick<NavigationActions, 'openPage'>): void {
  navigation.openPage(servedPage(), ViewType.INBOUND);
}
