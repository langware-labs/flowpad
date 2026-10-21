/**
 * A popup the app opens by itself — first-run setup on a new install — waits while a launch the
 * person asked for is on screen: two modals stack, and the popup covered the launch dialog and
 * whatever it had to say (on a first-time desktop, that the launch had failed).
 *
 * It waits SUSPENDED, never unmounted: an unmounted popup forgot that Start was pressed and came back blank.
 */
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useEntity: () => ({ data: { id: 'w' } }) };
});
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useQuery: () => ({ data: { mainRef: {} } }) };
});
vi.mock('@src/components/assets/editor/AssetEditorRouter', () => ({ recordContentRef: () => ({}) }));
vi.mock('@src/components/assets/editor/wizard/WizardViewer', () => ({
  WizardViewer: ({ suspended }: { suspended?: boolean }) => <div data-testid="viewer" data-suspended={String(suspended)} />,
}));

const { WizardPopupRoot } = await import('@src/components/assets/editor/wizard/WizardPopupRoot');
const { closeWizardPopup, openWizardPopup } = await import('@src/components/assets/editor/wizard/wizard-popup-store');
const { closeLaunch, openLaunch } = await import('@src/components/task-receive/launch-store');

const WIZARD = 'wizard-d5aa993d-a8b4-4728-9bdb-9d554f91d4db';

afterEach(() => {
  cleanup();
  closeLaunch();
  closeWizardPopup();
});

const renderRoot = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <WizardPopupRoot />
    </MemoryRouter>,
  );

describe('WizardPopupRoot', () => {
  it('keeps a popup opened during a launch mounted but suspended, and shows it once the launch is done', () => {
    openLaunch({ target: { projectId: 'acme' } });
    openWizardPopup(WIZARD);

    const { getByTestId } = renderRoot();
    expect(getByTestId('viewer').dataset.suspended).toBe('true');

    act(() => closeLaunch());
    expect(getByTestId('viewer').dataset.suspended).toBe('false');
  });

  it('keeps the popup mounted while the LLM chooser has the screen (it must remember Start was pressed)', () => {
    openWizardPopup(WIZARD);

    const { getByTestId } = renderRoot('/dock/llm-setup');

    expect(getByTestId('viewer').dataset.suspended).toBe('true');
  });
});
