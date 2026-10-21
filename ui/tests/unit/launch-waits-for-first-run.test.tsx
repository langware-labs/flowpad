/**
 * A launch link that arrives before the first-run wizard has run fully must not leave the screen empty.
 *
 * Two screens each waited for the other: the wizard popup stood aside for a launch on screen, and the launch dialog
 * waited for the gate the wizard opens. The launch is DEFERRED behind the flow, and the wizard is drawn.
 *
 * Real `IncomingDeepLink`, `WizardPopupRoot`, the launch store and the flow's store. Stand-ins: the gate's state
 * (closed), the launch dialog, the wizard viewer (it only records whether it was told to stand aside) and navigation.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/project-setup/first-run-gate', () => ({
  useFirstRunGate: () => ({ state: 'closed', continueAnyway: vi.fn() }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/notifications/notify', () => ({
  notify: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useAuth: () => ({ cloudUser: null }), useEntity: () => ({ data: { id: 'w' } }) };
});
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useQuery: () => ({ data: { mainRef: {} } }) };
});
vi.mock('@src/components/assets/editor/AssetEditorRouter', () => ({ recordContentRef: () => ({}) }));
vi.mock('@src/components/assets/editor/wizard/WizardViewer', () => ({
  WizardViewer: ({ suspended }: { suspended?: boolean }) => <div data-testid="viewer" data-suspended={String(suspended)} />,
}));
vi.mock('@src/components/task-receive/LaunchDialog', () => ({ LaunchDialog: () => <div data-testid="launch-dialog" /> }));

import { useFirstRunFlowStore } from '@src/components/first-run-flow/first-run-flow-store';
import { WizardPopupRoot } from '@src/components/assets/editor/wizard/WizardPopupRoot';
import { closeWizardPopup, openWizardPopup } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';
import { closeLaunch, openLaunch } from '@src/components/task-receive/launch-store';

afterEach(() => {
  cleanup();
  closeLaunch();
  closeWizardPopup();
  useFirstRunFlowStore.getState().end();
});

describe('a launch that arrives before the first-run wizard ran fully', () => {
  it('starts the flow, shows the wizard (not suspended) and holds its own dialog back', () => {
    act(() => openLaunch({ target: { projectId: 'acme' } }));
    render(
      <MemoryRouter>
        <IncomingDeepLink />
        <WizardPopupRoot />
      </MemoryRouter>,
    );
    expect(useFirstRunFlowStore.getState().step).toBe('wizard');
    expect(useFirstRunFlowStore.getState().origin).toBe('invitation');

    act(() => openWizardPopup('wizard-d5aa993d-a8b4-4728-9bdb-9d554f91d4db')); // what the flow does

    expect(screen.queryByTestId('launch-dialog')).toBeNull();
    expect(screen.getByTestId('viewer').dataset.suspended).toBe('false');
  });
});
