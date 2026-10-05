/**
 * A driver group is ONE choice for a person ("WhatsApp") with several ways to it. The picker shows one
 * tile for the group; its setup phase shows a card per member, each its live `profile()` (never
 * hardcoded here) — a member not available on this hub cannot be picked — and the chosen way is
 * connected with one button named for the group.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, DataDriver, TypeId } from '@sdk';

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
const WIZARD = [{ stage: 'connect', label: 'Connect', wizard: 'x-connect' }];

function spec(fields: Partial<DataDriver> & { name: string }) {
  return new DataDriver({ title: fields.name, sends: true, ...fields } as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open() {
  render(
    <TooltipProvider>
      <DataSourceDialog open onOpenChange={vi.fn()} owner={new TypeId(Agent.type, AGENT_ID)} />
    </TooltipProvider>,
  );
}

describe('a driver group', () => {
  const ours = spec({
    name: 'ours',
    title: 'Ours — no setup',
    group: 'Chat',
    group_order: 0,
    setup_wizards: WIZARD,
  } as never);
  const own = spec({
    name: 'own',
    title: 'Your own bot',
    group: 'Chat',
    group_order: 1,
    setup_wizards: WIZARD,
  } as never);
  hoisted.specs = [own, ours, spec({ name: 'slack', title: 'Slack' })];

  it('is one tile whose phase shows each way as its live card, connected with one button', async () => {
    vi.spyOn(DataDriver.prototype, 'profile').mockImplementation(async function (this: DataDriver) {
      return this.name === 'ours' ? { available: true, name: 'Flow', number: '+1 555 0100' } : {};
    });
    open();

    expect(screen.getByTestId('provider-group-Chat')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-ours')).toBeNull();
    expect(screen.queryByTestId('provider-own')).toBeNull();

    fireEvent.click(screen.getByTestId('provider-group-Chat'));
    const cards = screen.getAllByTestId(/^group-member-(ours|own)$/);
    expect(cards.map((c) => c.dataset.testid)).toEqual(['group-member-ours', 'group-member-own']);
    await waitFor(() => expect(screen.getByTestId('group-member-number-ours')).toHaveTextContent('Flow · +1 555 0100'));

    fireEvent.click(screen.getByTestId('group-member-ours'));
    expect(screen.getByLabelText(/Name/)).toHaveValue('Chat');
    expect(screen.getByRole('button', { name: 'Connect Chat' })).toBeInTheDocument();
  });

  it('cannot pick a way the hub does not offer, and says why', async () => {
    vi.spyOn(DataDriver.prototype, 'profile').mockImplementation(async function (this: DataDriver) {
      return this.name === 'ours' ? { available: false, detail: 'Not on your hub yet.' } : {};
    });
    open();
    fireEvent.click(screen.getByTestId('provider-group-Chat'));

    await waitFor(() => expect(screen.getByTestId('group-member-ours')).toBeDisabled());
    expect(screen.getByTestId('group-member-ours')).toHaveTextContent('Not on your hub yet.');
    expect(screen.getByTestId('group-member-own')).toBeEnabled();
  });
});
