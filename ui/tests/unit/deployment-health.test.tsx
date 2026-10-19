/**
 * A deployment's services, each with its health: the last recorded check until someone asks,
 * then "Check now" runs every service's check where it runs and paints what came back.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Deployment, EndpointHealth, ServiceEndpoint } from '@sdk';

import { DeploymentHealth } from '@src/components/assets/editor/agent-profile/deployment/DeploymentHealth';

function health(name: string, state: EndpointHealth['state'], detail = ''): EndpointHealth {
  return { endpoint_id: `e-${name}`, name, state, detail, observed_at: '2026-09-28T00:00:00Z' };
}

function endpoint(name: string, recorded: EndpointHealth | null, next?: EndpointHealth) {
  return {
    id: `e-${name}`,
    name,
    health: recorded,
    healthCheck: vi.fn().mockResolvedValue(next ?? recorded),
  } as unknown as ServiceEndpoint & { healthCheck: ReturnType<typeof vi.fn> };
}

function deployment(endpoints: ServiceEndpoint[], exposes: Array<{ name: string }> = []) {
  return { id: 'd1', exposes, endpoints: vi.fn().mockResolvedValue(endpoints) } as unknown as Deployment;
}

async function renderHealth(d: Deployment) {
  render(<DeploymentHealth deployment={d} />);
  await act(async () => undefined);
}

afterEach(cleanup);

describe('deployment health', () => {
  it('shows each service with its last recorded state, unknown before any check', async () => {
    await renderHealth(deployment([endpoint('chat', health('chat', 'alive')), endpoint('workspace', null)]));

    expect(screen.getByTestId('endpoint-health-chat')).toHaveAttribute('data-state', 'alive');
    expect(screen.getByTestId('endpoint-health-workspace')).toHaveAttribute('data-state', 'unknown');
  });

  it('checks every service now and paints what came back, detail included', async () => {
    const chat = endpoint('chat', health('chat', 'alive'), health('chat', 'failing', 'no process runs this loop'));
    const app = endpoint('app', null, health('app', 'alive'));
    await renderHealth(deployment([chat, app]));

    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-health-check-d1'));
    });

    expect(chat.healthCheck).toHaveBeenCalledTimes(1);
    expect(app.healthCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('endpoint-health-chat')).toHaveAttribute('data-state', 'failing');
    expect(screen.getByTestId('endpoint-health-chat')).toHaveAttribute('title', 'no process runs this loop');
    expect(screen.getByTestId('endpoint-health-app')).toHaveAttribute('data-state', 'alive');
    expect(screen.getByTestId('deployment-health-check-d1')).toHaveAttribute('data-state', 'failing');
  });

  it('says so when the deployment serves nothing', async () => {
    await renderHealth(deployment([]));

    expect(screen.getByTestId('deployment-health-d1')).toHaveTextContent('none');
    expect(screen.queryByTestId('deployment-health-check-d1')).toBeNull();
  });

  it('reports a check that did not answer instead of pretending', async () => {
    const chat = endpoint('chat', null);
    chat.healthCheck.mockRejectedValue(new Error('hub unreachable'));
    await renderHealth(deployment([chat]));

    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-health-check-d1'));
    });

    expect(screen.getByTestId('deployment-health-d1')).toHaveTextContent('hub unreachable');
  });

  it('shows a declared service nothing serves as failing', async () => {
    await renderHealth(deployment([endpoint('app', health('app', 'alive'))], [{ name: 'app' }, { name: 'chat' }]));

    expect(screen.getByTestId('endpoint-health-app')).toHaveAttribute('data-state', 'alive');
    expect(screen.getByTestId('endpoint-health-chat')).toHaveAttribute('data-state', 'failing');
    expect(screen.getByTestId('deployment-health-check-d1')).toHaveAttribute('data-state', 'failing');
  });
});
