import { dataManager, type TypeId, Wizard } from '@sdk';

import { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * The wizard popup's store: a wizard shown as a dialog OVER whatever page the person is on.
 *
 * Opened by the `open_wizard_popup` ui_command the backend sends when it wants a popup wizard in
 * front of a live tab (first-run setup, Settings → "Run setup again"), and by the footer chip / an
 * ask's "open the wizard" door — see `use-ui-command-listener.ts` and `WizardPopupRoot`. The payload
 * is the wizard's typeid.
 *
 * Store-driven rather than URL-driven, like the ask modal: the URL-first rule governs which view or
 * asset a click shows, and a popup is neither — it must leave the page behind it exactly as it was.
 */
const store = createOverlayStore<string>();
export const useWizardPopupStore = store.useStore;
export const openWizardPopup = store.open;
export const closeWizardPopup = store.close;

/**
 * Show a wizard: a popup wizard over the current page, any other wizard on its own page.
 *
 * The one decision, so every door to a wizard (the footer chip, an ask's link) answers it the same
 * way — by what the wizard's own document says (`popup`), never by which door was used.
 */
export async function showWizard(navigation: NavigationActions, typeId: TypeId): Promise<void> {
  const wizard = await dataManager.getByTypeId<Wizard>(typeId).catch(() => null);
  if (wizard?.popup) openWizardPopup(typeId.toString());
  else navigation.openDock(DockPointer.forAssetEditorByTypeId('wizard', typeId));
}
