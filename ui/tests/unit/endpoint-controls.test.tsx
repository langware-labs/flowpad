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

import {
  DEFAULT_MODELS,
  EndpointControls,
  SEED_BY_SCOPE,
  aliasesForPinnedModel,
} from '@src/components/organization/budgets/EndpointControls';

/**
 * REGRESSION: the seed used to be the single `sm` slug, which refused the model a normal prompt
 * asks for. `CLAUDE_API_AUTH_SPEC.tier_models` maps sm/md/lg to haiku/sonnet/opus and `md` is the
 * ordinary default, so an allow-list must not pin one tier.
 */

/**
 * Pinning one model must STICK rather than refuse. The tier a person's machine asks for lives in
 * their own CLI config, which this page cannot reach, so narrowing `models_allow` alone produced
 * "model anthropic/claude-sonnet-4.5 not allowed by endpoint Gadi +20" and left the person with no
 * way to fix it. The hub resolves `filters.aliases` at the entry BEFORE the filter check and
 * rewrites the request, so the redirect is what makes a pin work unattended.
 */
/**
 * A child may only NARROW its parent (`is_subset`, a 400 on write), and the check is against the
 * IMMEDIATE parent chain. So any row that states a model becomes a ceiling for everything under it,
 * and pinning the TEAM would make "move this one person to sonnet" an illegal write.
 */
describe('SEED_BY_SCOPE', () => {
  it('states a ceiling on the org and the cheap default on a person', () => {
    expect(SEED_BY_SCOPE.org).toEqual(['anthropic/claude-*', 'openai/gpt-*']);
    expect(SEED_BY_SCOPE.person).toEqual(['anthropic/claude-haiku-4.5']);
  });

  it('leaves the team blank, so it can never be what blocks a per-person override', () => {
    expect(SEED_BY_SCOPE.team).toEqual([]);
  });

  it("keeps every person's default inside the org's ceiling", () => {
    const covered = (slug: string) =>
      SEED_BY_SCOPE.org.some((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(slug));
    for (const slug of SEED_BY_SCOPE.person) expect(covered(slug)).toBe(true);
  });
});

describe('aliasesForPinnedModel', () => {
  it('redirects a family onto the one model allowed in it', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
    });
  });

  it('handles one list spanning both harnesses — Claude Code and codex each get their own', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'openai/gpt-*': 'openai/gpt-5-mini',
    });
  });

  it('never answers a request for one vendor with another vendor s model', () => {
    const aliases = aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini']);
    for (const [pattern, target] of Object.entries(aliases)) {
      expect(target.split('/')[0]).toBe(pattern.split('/')[0]);
    }
  });

  it('leaves a family alone when a glob already opens it', () => {
    // The org ceiling. Everything in these families passes on its own; a redirect would NARROW it.
    expect(aliasesForPinnedModel(['anthropic/claude-*', 'openai/gpt-*'])).toEqual({});
    expect(aliasesForPinnedModel(['anthropic/claude-*'])).toEqual({});
  });

  it('keeps every explicitly allowed model reachable, and sends the rest to the first', () => {
    // An exact key beats the glob in `resolve_alias`, so sonnet stays sonnet while opus — which the
    // admin did NOT list — falls through to haiku.
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
    });
  });

  it('mixes a pinned family with a wide-open one', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-*'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
    });
  });

  it('covers a model that did not exist when this was written', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-something-new-9'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-something-new-9',
    });
  });

  it('redirects nothing for an empty list', () => {
    expect(aliasesForPinnedModel([])).toEqual({});
  });
});

describe('DEFAULT_MODELS', () => {
  it('is the cheap tier, and carries a redirect so it still serves every caller', () => {
    expect(DEFAULT_MODELS).toEqual(['anthropic/claude-haiku-4.5']);
    // The narrowness is only safe BECAUSE the other tiers redirect onto it.
    expect(aliasesForPinnedModel(DEFAULT_MODELS)).toEqual({ 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' });
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
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);
    expect(screen.queryByTestId('org-enabled')).toBeNull();
  });

  it('seeds the cheapest model onto a wallet that has none, exactly once', async () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][0].toString()).toBe(TYPE_ID);
    expect(h.save.mock.calls[0][2]).toEqual({
      // The cheap default is pinned AND redirected, so it serves every tier instead of
      // refusing the ones a machine is actually configured for.
      filters: {
        ...endpoint().filters,
        models_allow: ['anthropic/claude-haiku-4.5'],
        aliases: { 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' },
      },
    });
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
  });

  it('repairs a row that is pinned but has no redirect, without anyone touching it', async () => {
    // Every row pinned before aliasing existed. Re-typing the same model is a no-op at `commit`
    // and the empty-list seed never fires here, so if this did not self-heal the row would refuse
    // every `md`-tier caller forever.
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const filters = (h.save.mock.calls[0][2] as { filters: Record<string, unknown> }).filters;
    expect(filters.models_allow).toEqual(['anthropic/claude-haiku-4.5'], 'the pin itself is left alone');
    expect(filters.aliases).toEqual({ 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' });
  });

  it('leaves a row alone once its redirect already matches its pin', () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: ['anthropic/claude-haiku-4.5'],
          aliases: { 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' },
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('never seeds a team row, leaving it blank to inherit', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: [] } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="team" testIdPrefix="team-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('seeds an org row with the ceiling, not the cheap default', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: [] } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" />);
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const filters = (h.save.mock.calls[0][2] as { filters: Record<string, unknown> }).filters;
    expect(filters.models_allow).toEqual(['anthropic/claude-*', 'openai/gpt-*']);
    expect(filters.aliases).toEqual({}, 'globs pin nothing, so no redirect');
  });

  it('does not seed a wallet that already has models', () => {
    // Its redirect already matches its pin, so there is nothing to seed and nothing to repair.
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: ['anthropic/claude-opus-4'],
          aliases: { 'anthropic/claude-*': 'anthropic/claude-opus-4' },
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('shows the models already on the wallet, and the default only as a placeholder otherwise', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-*', 'openai/gpt-4*'] } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);
    expect(screen.getByTestId('org-models').textContent).toBe('anthropic/claude-*, openai/gpt-4*');
  });

  it('saves an edited model list as a full filters PUT, leaving other filter fields untouched', async () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: DEFAULT_MODELS,
          aliases: { 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' },
          streaming: 'require',
          max_tokens_ceiling: 4096,
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);

    fireEvent.click(screen.getByTestId('org-models'));
    fireEvent.change(screen.getByTestId('org-models-input'), {
      target: { value: 'anthropic/claude-*, openai/gpt-4*' },
    });
    fireEvent.blur(screen.getByTestId('org-models-input'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][2]).toEqual({
      filters: {
        models_allow: ['anthropic/claude-*', 'openai/gpt-4*'],
        aliases: {},
        streaming: 'require',
        max_tokens_ceiling: 4096,
      },
    });
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
  });

  it('writes the tier redirect when an admin pins the row to one model', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-*', 'openai/gpt-*'] } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);

    fireEvent.click(screen.getByTestId('org-models'));
    fireEvent.change(screen.getByTestId('org-models-input'), {
      target: { value: 'anthropic/claude-haiku-4.5' },
    });
    fireEvent.blur(screen.getByTestId('org-models-input'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const filters = (h.save.mock.calls[0][2] as { filters: Record<string, unknown> }).filters;
    expect(filters.models_allow).toEqual(['anthropic/claude-haiku-4.5']);
    // A machine configured for sonnet now transparently receives haiku.
    expect(filters.aliases).toEqual({ 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' });
  });

  it('refuses to save an edit that would leave the field empty', async () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: DEFAULT_MODELS,
          aliases: { 'anthropic/claude-*': 'anthropic/claude-haiku-4.5' },
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);

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
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(h.save).toHaveBeenCalledWith(expect.anything(), [], { enabled: false }));
  });

  it('renders the Test button for this endpoint', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: DEFAULT_MODELS } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" />);
    expect(screen.getByTestId(`stub-test-${UUID}`)).toBeTruthy();
  });
});
