/**
 * New deployment: pick a type (this computer, or a cloud machine size), see what launching that
 * type needs, Launch. Only a cloud machine asks for the publish checklist and an environment.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@sdk';

vi.mock('@src/components/assets/editor/agent-profile/AgentDeployChecklist', () => ({
  AgentDeployChecklist: () => <div data-testid="mock-checklist" />,
}));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { NewDeploymentDialog } from '@src/components/assets/editor/agent-profile/NewDeploymentDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(hasLocal = false) {
  const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });
  const deploy = vi.spyOn(agent, 'deploy').mockResolvedValue({ deployment: { id: 'dep-1' } } as never);
  const onMachineSize = vi.fn().mockResolvedValue(true);
  const onLaunched = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <NewDeploymentDialog
      agent={agent}
      open
      onOpenChange={onOpenChange}
      hasLocal={hasLocal}
      onMachineSize={onMachineSize}
      onLaunched={onLaunched}
    />,
  );
  return { deploy, onMachineSize, onLaunched, onOpenChange };
}

describe('New deployment', () => {
  it('offers this computer and every cloud machine size, this computer first', () => {
    renderDialog();
    const types = screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid'));
    expect(types).toEqual(['new-deployment-type-local', 'new-deployment-type-sm', 'new-deployment-type-md', 'new-deployment-type-lg']);
    expect(screen.getByTestId('new-deployment-type-local')).toHaveAttribute('aria-checked', 'true');
  });

  it('this computer needs no publish checklist and no environment — Launch deploys it here', async () => {
    const { deploy, onMachineSize, onLaunched } = renderDialog();
    expect(screen.getByTestId('new-deployment-local-details')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-checklist')).toBeNull();
    expect(screen.queryByTestId('new-deployment-environment')).toBeNull();
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith(undefined, 'local'));
    expect(onMachineSize).not.toHaveBeenCalled();
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('dep-1'));
  });

  it('a cloud machine shows the checklist and environment, and saves its size before deploying', async () => {
    const order: string[] = [];
    const { deploy, onMachineSize } = renderDialog();
    onMachineSize.mockImplementation(async () => order.push('size'));
    deploy.mockImplementation(async () => {
      order.push('deploy');
      return { deployment: { id: 'dep-2' } } as never;
    });
    fireEvent.click(screen.getByTestId('new-deployment-type-md'));
    expect(screen.getByTestId('mock-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('new-deployment-environment')).toHaveValue('production');
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith('production'));
    expect(onMachineSize).toHaveBeenCalledWith('md');
    expect(order).toEqual(['size', 'deploy']);
  });

  it('this computer cannot be launched twice', () => {
    renderDialog(true);
    expect(screen.getByTestId('new-deployment-type-local')).toBeDisabled();
    expect(screen.getByTestId('new-deployment-type-sm')).toHaveAttribute('aria-checked', 'true');
  });
});
