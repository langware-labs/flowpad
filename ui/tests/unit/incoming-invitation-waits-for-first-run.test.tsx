/**
 * An invitation to a project is a project setup that starts with a dialog -- and that dialog is not shown until
 * the first-run flow has ended with the gate open (`agentic-assets/chart/first-run-wizard-flow`). Nothing else
 * the link carries shows meanwhile either.
 *
 * Real `IncomingDeepLink` and the flow's store. Stand-ins: the pending invitation, the gate, the dialog itself
 * (its own behaviour is covered elsewhere) and dock navigation.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  gateState: 'closed' as 'loading' | 'closed' | 'open',
  pending: {
    gitOrigin: { kind: 'git', url: 'https://github.com/acme/course.git', branch: 'main', rel_path: '' },
    projectName: 'course',
    senderName: 'Dana',
    projectId: '11111111-1111-4111-8111-111111111111',
  } as Record<string, unknown> | null,
}));

vi.mock('@src/components/project-setup/first-run-gate', () => ({
  useFirstRunGate: () => ({ state: h.gateState, continueAnyway: vi.fn() }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/notifications/notify', () => ({
  notify: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ cloudUser: null }) }));
vi.mock('@src/store/use-incoming-project-store', () => ({
  useIncomingProjectStore: () => ({ pendingProject: h.pending, setPendingProject: vi.fn() }),
  isSetupDeclined: () => false,
}));
vi.mock('@src/components/task-receive/IncomingProjectDialog', () => ({
  IncomingProjectDialog: () => <div data-testid="incoming-project-dialog" />,
}));

import { useFirstRunFlowStore } from '@src/components/first-run-flow/first-run-flow-store';
import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';

afterEach(() => {
  cleanup();
  useFirstRunFlowStore.getState().end();
});

describe('the invitation dialog and the first-run flow', () => {
  it('is not shown while the wizard has not run fully; the flow starts instead, for an invitation', () => {
    h.gateState = 'closed';
    render(<IncomingDeepLink />);

    expect(screen.queryByTestId('incoming-project-dialog')).toBeNull();
    expect(useFirstRunFlowStore.getState().step).toBe('wizard');
    expect(useFirstRunFlowStore.getState().origin).toBe('invitation');
  });

  it('is not shown while the gate is still being looked up -- never a flash before the answer', () => {
    h.gateState = 'loading';
    render(<IncomingDeepLink />);

    expect(screen.queryByTestId('incoming-project-dialog')).toBeNull();
    expect(useFirstRunFlowStore.getState().step).toBe('idle');
  });

  it('is shown at once when the wizard already ran fully -- nothing of the wizard is in the way', () => {
    h.gateState = 'open';
    render(<IncomingDeepLink />);

    expect(screen.getByTestId('incoming-project-dialog')).toBeTruthy();
    expect(useFirstRunFlowStore.getState().step).toBe('idle');
  });

  it('is shown after the flow ends with the gate open, and not before', () => {
    h.gateState = 'closed';
    const { rerender } = render(<IncomingDeepLink />);
    expect(screen.queryByTestId('incoming-project-dialog')).toBeNull();

    // The flow is still on window 3 when the gate opens (Continue anyway): the dialog still waits for the flow.
    h.gateState = 'open';
    useFirstRunFlowStore.getState().setStep('how-to');
    rerender(<IncomingDeepLink />);
    expect(screen.queryByTestId('incoming-project-dialog')).toBeNull();

    act(() => useFirstRunFlowStore.getState().end());
    expect(screen.getByTestId('incoming-project-dialog')).toBeTruthy();
  });
});
