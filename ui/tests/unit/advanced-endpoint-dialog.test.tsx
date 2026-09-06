/**
 * "Advanced" — the endpoint knobs the budgets page deliberately keeps off the row.
 *
 * The contract worth pinning is the OMISSION. `cost_usd_total` and `models_allow` are edited on
 * the row itself; offering them here as well would show one value in two shapes, saved by two
 * paths, with nothing to say which wins. Everything else the expert dialog exposes belongs here.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  endpoint: vi.fn(),
  save: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
}));

vi.mock('@src/components/llm-endpoints/use-llm-endpoints', () => ({
  useLlmEndpoint: (...args: unknown[]) => h.endpoint(...args),
}));
vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useInvalidateBudgets: () => h.invalidate,
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dataManager: { save: (...args: unknown[]) => h.save(...args) } };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { AdvancedButton, AdvancedEndpointDialog } from '@src/components/organization/budgets/AdvancedEndpointDialog';

const TYPEID = 'llm_endpoint-550e8400-e29b-41d4-a716-446655440099';
const BARE = '550e8400-e29b-41d4-a716-446655440099';

function endpointOf(over: Record<string, unknown> = {}) {
  return {
    id: BARE,
    typeId: { toString: () => TYPEID },
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api',
    enabled: true,
    filters: { models_allow: ['anthropic/claude-*'], models_deny: [], streaming: 'allow' },
    limits: { cost_usd_total: 50, tokens_per_day: 1000 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.endpoint.mockReturnValue(endpointOf());
});
afterEach(cleanup);

describe('AdvancedEndpointDialog', () => {
  it('offers the per-window limits the row does not', () => {
    render(<AdvancedEndpointDialog open onOpenChange={vi.fn()} endpointId={TYPEID} scopeLabel="Acme" />);

    expect(screen.getByTestId('limits-editor')).toBeTruthy();
    expect(screen.getByTestId('filters-editor')).toBeTruthy();
    expect(screen.getByLabelText('Tokens / day')).toBeTruthy();
    expect(screen.getByLabelText('Requests / minute')).toBeTruthy();
  });

  /** The whole point of the split: these two live on the row, so they must NOT be here. */
  it('omits the total and the allowed-models list, which the row already edits', () => {
    render(<AdvancedEndpointDialog open onOpenChange={vi.fn()} endpointId={TYPEID} scopeLabel="Acme" />);

    expect(screen.queryByLabelText('Cost (USD), total')).toBeNull();
    expect(screen.queryByLabelText('Models allowed (globs)')).toBeNull();
    // A neighbour in the same group is still offered — the omission is one field, not the group.
    expect(screen.getByLabelText('Cost (USD) / day')).toBeTruthy();
    expect(screen.getByLabelText('Models denied (globs)')).toBeTruthy();
  });

  it('accepts a typeid or a bare uuid, normalizing before the lookup', () => {
    render(<AdvancedEndpointDialog open onOpenChange={vi.fn()} endpointId={TYPEID} scopeLabel="Acme" />);
    expect(h.endpoint).toHaveBeenCalledWith(BARE);
  });

  /** Read-only on purpose: the hub refuses to change either once the endpoint exists, so an
   *  editable field would be a form that lies. */
  it('shows a root’s provider and base URL without offering to change them', () => {
    render(<AdvancedEndpointDialog open onOpenChange={vi.fn()} endpointId={TYPEID} scopeLabel="Acme" />);

    expect(screen.getByTestId('advanced-provider').textContent).toContain('OpenRouter');
    expect(screen.getByTestId('advanced-base-url').textContent).toContain('openrouter.ai');
    expect(screen.queryByLabelText('Base URL')).toBeNull();
  });

  it('saves filters and limits together, and closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<AdvancedEndpointDialog open onOpenChange={onOpenChange} endpointId={TYPEID} scopeLabel="Acme" />);

    await user.clear(screen.getByLabelText('Tokens / day'));
    await user.type(screen.getByLabelText('Tokens / day'), '250');
    await user.click(screen.getByTestId('advanced-save'));

    await waitFor(() => expect(h.save).toHaveBeenCalled());
    const body = h.save.mock.calls[0][2] as { limits: Record<string, unknown>; filters: Record<string, unknown> };
    expect(body.limits.tokens_per_day).toBe(250);
    // `filters` is a whole-object write on the hub, so the untouched fields must travel too —
    // sending a partial object silently resets every filter this dialog did not display.
    expect(body.filters.models_allow).toEqual(['anthropic/claude-*']);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('refuses to save a negative limit and says so', async () => {
    const user = userEvent.setup();
    render(<AdvancedEndpointDialog open onOpenChange={vi.fn()} endpointId={TYPEID} scopeLabel="Acme" />);

    await user.clear(screen.getByLabelText('Tokens / day'));
    await user.type(screen.getByLabelText('Tokens / day'), '-5');

    expect(screen.getByTestId('advanced-problems')).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>('advanced-save').disabled).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('waits for the entity rather than seeding the form from defaults', () => {
    // Seeding from defaults would make the whole-object `filters` write reset what it never showed.
    h.endpoint.mockReturnValue(null);
    render(<AdvancedEndpointDialog open onOpenChange={vi.fn()} endpointId={TYPEID} scopeLabel="Acme" />);

    expect(screen.queryByTestId('limits-editor')).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>('advanced-save').disabled).toBe(true);
  });
});

describe('AdvancedButton', () => {
  it('opens the dialog only once pressed — the endpoint is not read on page paint', async () => {
    const user = userEvent.setup();
    render(<AdvancedButton endpointId={TYPEID} scopeLabel="Acme" testId="org-advanced" />);

    expect(screen.queryByTestId('advanced-endpoint-dialog')).toBeNull();
    await user.click(screen.getByTestId('org-advanced'));
    expect(screen.getByTestId('advanced-endpoint-dialog')).toBeTruthy();
  });
});
