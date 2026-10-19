/**
 * The wizard popup's overlay store, and the one rule that picks popup or page.
 *
 * A popup wizard is a dialog OVER the page the person is on; any other wizard has its own page.
 * Every door to a wizard (the footer chip, an ask's link) goes through `showWizard`, so they cannot
 * disagree about which it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getByTypeId: vi.fn() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dataManager: { getByTypeId: h.getByTypeId } };
});

import { TypeId, Wizard } from '@sdk';
import {
  closeWizardPopup,
  openWizardPopup,
  showWizard,
  useWizardPopupStore,
} from '@src/components/assets/editor/wizard/wizard-popup-store';

const typeId = new TypeId(Wizard.type, '5d38c372-13af-4aa8-8492-4fcdaaca447d');

beforeEach(() => {
  vi.clearAllMocks();
  closeWizardPopup();
});
afterEach(closeWizardPopup);

describe('showWizard', () => {
  it('opens a popup wizard as an overlay and does not navigate anywhere', async () => {
    h.getByTypeId.mockResolvedValue({ popup: true });
    const navigation = { openDock: vi.fn() };
    await showWizard(navigation as never, typeId);
    expect(useWizardPopupStore.getState().open).toBe(true);
    expect(useWizardPopupStore.getState().payload).toBe(typeId.toString());
    expect(navigation.openDock).not.toHaveBeenCalled();
  });

  it('takes any other wizard to its own page', async () => {
    h.getByTypeId.mockResolvedValue({ popup: false });
    const navigation = { openDock: vi.fn() };
    await showWizard(navigation as never, typeId);
    expect(navigation.openDock).toHaveBeenCalledTimes(1);
    expect(useWizardPopupStore.getState().open).toBe(false);
  });

  it('falls back to the wizard′s page when it cannot be read', async () => {
    h.getByTypeId.mockRejectedValue(new Error('gone'));
    const navigation = { openDock: vi.fn() };
    await showWizard(navigation as never, typeId);
    expect(navigation.openDock).toHaveBeenCalledTimes(1);
  });
});

describe('the popup store', () => {
  it('closing clears which wizard was open', () => {
    openWizardPopup('wizard-x');
    expect(useWizardPopupStore.getState().payload).toBe('wizard-x');
    closeWizardPopup();
    expect(useWizardPopupStore.getState().open).toBe(false);
    expect(useWizardPopupStore.getState().payload).toBeNull();
  });
});
