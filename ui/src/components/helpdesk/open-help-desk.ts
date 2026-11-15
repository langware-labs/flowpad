import { servedPage } from '@src/lib/hub-page-url';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateTo } from '@src/notifications';

/** Open a help desk's own page, on whichever page this app serves (the hub page, or the desktop). */
export function openHelpDesk(deskId: string): void {
  navigateTo(DockPointer.forDesk(deskId).withPage(servedPage()).toUrl());
}
