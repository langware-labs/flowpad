/**
 * `EndpointControls` — the enable switch, the click-to-edit models-allow field, and the Test
 * button that budget rows (org/team/person) share with the expert LLM Endpoints screen.
 *
 * Locked here: a wallet with no models yet self-heals onto `DEFAULT_MODELS` (once per mount, not
 * on every render), an edit that would clear the field is refused rather than saved, a real edit
 * is sent as a `filters` PUT that keeps every OTHER filter field untouched (the hub does not merge
 * `filters`), and the enabled switch flips `enabled` the same way. `TestEndpointButton` itself is
 * covered by its own suite; here it only needs to render.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID = '550e8400-e29b-41d4-a716-446655440099';
const TYPE_ID = `llm_endpoint-${UUID}`;

const h = vi.hoisted(() => ({
  endpoint: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmEndpoint: (...args: unknown[]) => h.endpoint(...args),
}));
vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useInvalidateBudgets: () => h.invalidate,
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
  };
});
// Its own dedicated suite covers the call/verdict cycle; here it only needs to exist so the row
// renders — asserting on its testid is enough to know it is actually wired in.
vi.mock('@src/components/llm-endpoints/TestEndpointButton', () => ({
  TestEndpointButton: ({ endpointId }: { endpointId: string }) => <div data-testid={`stub-test-${endpointId}`} />,
}));

import { DEFAULT_MODELS, EndpointControls } from '@src/components/organization/budgets/EndpointControls';

/**
 * REGRESSION: the seed used to be the single `sm` slug, which refused the model a normal prompt
 * asks for. `CLAUDE_API_AUTH_SPEC.tier_models` maps sm/md/lg to haiku/sonnet/opus and `md` is the
 * ordinary default, so an allow-list must not pin one tier.
 */
describe('DEFAULT_MODELS', () => {
  it('admits every Claude tier a worker can ask for, not just the cheapest', () => {
    const tiers = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.1'];
    const matches = (slug: string) =>
      DEFAULT_MODELS.some((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(slug));
    for (const slug of tiers) expect(matches(slug)).toBe(true);
  });
});

function endpoint(over: Record<string, unknown> = {}) {
  return {
    id: UUID,
    typeId: { toString: () => TYPE_ID },
    enabled: true,
    filters: { models_allow: [], models_deny: [], streaming: 'allow', max_tokens_ceiling: null },
    ...over,
  };
}

describe('EndpointControls', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.save.mockResolvedValue(undefined);
    h.invalidate.mockResolvedValue(undefined);
  });

  it('shows a spinner until the endpoint itself has loaded', () => {
    h.endpoint.mockReturnValue(null);
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);
    expect(screen.queryByTestId('org-enabled')).toBeNull();
  });

  it('seeds the cheapest model onto a wallet that has none, exactly once', async () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][0].toString()).toBe(TYPE_ID);
    expect(h.save.mock.calls[0][2]).toEqual({ filters: { ...endpoint().filters, models_allow: DEFAULT_MODELS } });
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
  });

  it('does not seed a wallet that already has models', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-opus-4'] } }));
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('shows the models already on the wallet, and the default only as a placeholder otherwise', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-*', 'openai/gpt-4*'] } }));
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);
    expect(screen.getByTestId('org-models').textContent).toBe('anthropic/claude-*, openai/gpt-4*');
  });

  it('saves an edited model list as a full filters PUT, leaving other filter fields untouched', async () => {
    h.endpoint.mockReturnValue(
      endpoint({ filters: { models_allow: DEFAULT_MODELS, streaming: 'require', max_tokens_ceiling: 4096 } }),
    );
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);

    fireEvent.click(screen.getByTestId('org-models'));
    fireEvent.change(screen.getByTestId('org-models-input'), {
      target: { value: 'anthropic/claude-*, openai/gpt-4*' },
    });
    fireEvent.blur(screen.getByTestId('org-models-input'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][2]).toEqual({
      filters: {
        models_allow: ['anthropic/claude-*', 'openai/gpt-4*'],
        streaming: 'require',
        max_tokens_ceiling: 4096,
      },
    });
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
  });

  it('refuses to save an edit that would leave the field empty', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: DEFAULT_MODELS } }));
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);

    fireEvent.click(screen.getByTestId('org-models'));
    fireEvent.change(screen.getByTestId('org-models-input'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByTestId('org-models-input'));

    // The one call left standing is the seed check, which found the field already non-empty.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-models').textContent).toBe(DEFAULT_MODELS.join(', '));
  });

  it('flips enabled through the switch', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: DEFAULT_MODELS }, enabled: true }));
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(h.save).toHaveBeenCalledWith(expect.anything(), [], { enabled: false }));
  });

  it('renders the Test button for this endpoint', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: DEFAULT_MODELS } }));
    render(<EndpointControls endpointId={TYPE_ID} testIdPrefix="org" />);
    expect(screen.getByTestId(`stub-test-${UUID}`)).toBeTruthy();
  });
});
