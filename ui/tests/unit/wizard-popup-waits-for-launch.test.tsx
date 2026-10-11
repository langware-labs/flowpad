/**
 * A popup the app opens by itself — first-run setup on a new install — waits while a launch the
 * person asked for is on screen: two modals stack, and the popup covered the launch dialog and
 * whatever it had to say (on a first-time desktop, that the launch had failed).
 */
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** How many times the popup's host mounted far enough to read its wizard — i.e. the popup is up. */
const h = vi.hoisted(() => ({ hostReads: 0 }));

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useEntity: () => {
      h.hostReads += 1;
      return { data: null };
    },
  };
});
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useQuery: () => ({ data: null }) };
});

const { WizardPopupRoot } = await import('@src/components/assets/editor/wizard/WizardPopupRoot');
const { closeWizardPopup, openWizardPopup } = await import('@src/components/assets/editor/wizard/wizard-popup-store');
const { closeLaunch, openLaunch } = await import('@src/components/task-receive/launch-store');

const WIZARD = 'wizard-d5aa993d-a8b4-4728-9bdb-9d554f91d4db';

afterEach(() => {
  cleanup();
  closeLaunch();
  closeWizardPopup();
});

describe('WizardPopupRoot', () => {
  it('holds a popup opened during a launch, and shows it once the launch is done', () => {
    openLaunch({ target: { projectId: 'spora' } });
    openWizardPopup(WIZARD);

    render(
      <MemoryRouter>
        <WizardPopupRoot />
      </MemoryRouter>,
    );
    expect(h.hostReads).toBe(0);

    act(() => closeLaunch());
    expect(h.hostReads).toBeGreaterThan(0);
  });
});
