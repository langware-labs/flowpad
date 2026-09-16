/**
 * The picker offers what we provide, not the vendor behind it: Agent Email is a
 * provisioned provider the cloud allocates for an agent (no form), and AgentMail
 * is unlisted.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, DataDriver, TypeId, User } from '@sdk';

const hoisted = vi.hoisted(() => ({ specs: [] as unknown[] }));
vi.mock('@src/components/data-sources/use-source-specs', () => ({
  useSourceSpecs: () => ({
    specs: hoisted.specs,
    specFor: (name: string) => (hoisted.specs as { name: string }[]).find((s) => s.name === name),
  }),
}));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@src/components/quick-create/QuickCreatePanel', () => ({
  TILE_TIP_DELAY: 0,
  TileSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DesktopTile: ({ label, onClick, ...rest }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick} {...rest}>
      {label}
    </button>
  ),
}));

import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { TooltipProvider } from '@src/components/ui/tooltip';

const AGENT_ID = '33333333-3333-4333-8333-333333333333';

function spec(fields: Partial<DataDriver> & { name: string }) {
  return new DataDriver({ title: fields.name, sends: true, ...fields } as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('add a channel', () => {
  hoisted.specs = [
    spec({ name: 'agentmail', title: 'AgentMail', listed: false }),
    spec({
      name: 'cloud_email',
      title: 'Agent Email',
      description: 'An email address Flowpad creates for this agent.',
      provisioned: true,
      config: { agent_id: { type: 'text', required: true, label: 'Agent' } },
    }),
    spec({ name: 'slack', title: 'Slack' }),
  ];

  it('offers Agent Email for an agent, never the vendor, and allocates instead of a form', async () => {
    const allocate = vi.spyOn(Agent.prototype, 'allocateInbox').mockResolvedValue({} as never);
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <DataSourceDialog open onOpenChange={onOpenChange} owner={new TypeId(Agent.type, AGENT_ID)} />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId('provider-agentmail')).toBeNull();
    fireEvent.click(screen.getByTestId('provider-cloud_email'));
    expect(screen.getByTestId('provisioned-source-note')).toHaveTextContent('creates for this agent');
    expect(screen.queryByLabelText(/Name/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create Agent Email' }));
    await waitFor(() => expect(allocate).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not offer Agent Email when the source is not an agent’s', () => {
    render(
      <TooltipProvider>
        <DataSourceDialog open onOpenChange={vi.fn()} owner={new TypeId(User.type, AGENT_ID)} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('provider-cloud_email')).toBeNull();
    expect(screen.queryByTestId('provider-agentmail')).toBeNull();
    expect(screen.getByTestId('provider-slack')).toBeInTheDocument();
  });
});
