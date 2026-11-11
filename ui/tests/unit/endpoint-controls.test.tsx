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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID = '550e8400-e29b-41d4-a716-446655440099';
const TYPE_ID = `llm_endpoint-${UUID}`;

const h = vi.hoisted(() => ({
  endpoint: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
  refetchEndpoints: vi.fn(),
  listModels: vi.fn(),
  providerSizes: vi.fn(),
  verdict: vi.fn(),
}));

vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmEndpoint: (...args: unknown[]) => h.endpoint(...args),
  // The row re-reads the endpoints after a save, because a TEAM edit moves the members' lists on
  // the hub and nothing tells this client about writes it did not make.
  useLlmEndpoints: () => ({ endpoints: [], isLoading: false, refetch: h.refetchEndpoints, error: null }),
  // Static, the same for every row: the sizes each provider declares, served by the hub.
  useLlmProviderSizes: (...args: unknown[]) => ({ data: h.providerSizes(...args) }),
}));
// The probe itself has its own suite; here it only needs to hand this row a verdict on demand, so
// the row's own rendering of it is what is under test.
vi.mock('@src/components/llm-endpoints/TestEndpointButton', () => ({
  TestEndpointButton: ({
    endpointId,
    onVerdict,
    inlineVerdict,
  }: {
    endpointId: string;
    onVerdict?: (v: unknown) => void;
    inlineVerdict?: boolean;
  }) => (
    <button
      data-testid={`stub-test-${endpointId}`}
      data-inline-verdict={String(inlineVerdict)}
      onClick={() => onVerdict?.(h.verdict())}
    />
  ),
}));
vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useInvalidateBudgets: () => h.invalidate,
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save },
    llmEndpointsService: { ...(actual.llmEndpointsService as object), listModels: h.listModels },
  };
});
// Its own dedicated suite covers the call/verdict cycle; here it only needs to exist so the row
// renders — asserting on its testid is enough to know it is actually wired in.
import { EndpointControls } from '@src/components/organization/budgets/EndpointControls';
import {
  DEFAULT_MODELS,
  SEED_BY_SCOPE,
  aliasesForPinnedModel,
  reconcileAliases,
  sameAliases,
  presetEntries,
  MODEL_FAMILY_PRESETS,
  withModelEntries,
} from '@src/components/organization/budgets/budget-models';

/**
 * REGRESSION: the seed used to be the single `sm` slug, which refused the model a normal prompt
 * asks for. `CLAUDE_API_AUTH_SPEC.tier_models` maps sm/md/lg to haiku/sonnet/opus and `md` is the
 * ordinary default, so an allow-list must not pin one tier.
 */

/**
 * Pinning one model must STICK rather than refuse. The tier a person's machine asks for lives in
 * their own CLI config, which this page cannot reach, so narrowing `models_allow` alone produced
 * "model anthropic/claude-sonnet-4.5 not allowed by endpoint Bob +20" and left the person with no
 * way to fix it. The hub resolves `filters.aliases` at the entry BEFORE the filter check and
 * rewrites the request, so the redirect is what makes a pin work unattended.
 */
/**
 * A child may only NARROW its parent (`is_subset`, a 400 on write), and the check is against the
 * IMMEDIATE parent chain. So any row that states a model becomes a ceiling for everything under it,
 * and pinning the TEAM would make "move this one person to sonnet" an illegal write.
 */
describe('SEED_BY_SCOPE', () => {
  /** These are a HINT now, not a write: the hub chooses what a new wallet allows
   *  (`_seed_models` / `MEMBER_DEFAULT_MODELS` in `hub llm_endpoint.py`), because it
   *  is also what mints a person's default on their first bootstrap — a path this screen is not on,
   *  and the reason a person used to be restricted only if an admin had opened the page. Kept in
   *  step by hand, like the asset-editor contract: drift shows up as a stale placeholder, never as
   *  a wrong value on a row. */
  it('mirrors the hub: a ceiling on the org, the cheap tier below it', () => {
    expect(SEED_BY_SCOPE.org).toEqual(['anthropic/claude-*', 'openai/*']);
    expect(SEED_BY_SCOPE.person).toEqual([
      'anthropic/claude-haiku-5.5',
      'openai/gpt-5-mini',
      'openai/text-embedding-3-small',
    ]);
  });

  it('gives the team the same cheap tier as a person', () => {
    // It used to be blank so it could never block a per-person override. It no longer has to be:
    // a person is minted with WHAT THE TEAM HAS, so the team stating a value is what the person
    // starts from rather than something they have to be exempted from.
    expect(SEED_BY_SCOPE.team).toEqual(SEED_BY_SCOPE.person);
  });

  it("keeps every lower default inside the org's ceiling", () => {
    // The regression that would otherwise ship silently: a seed the org does not cover is legal at
    // creation (a fresh row has no sources yet) and then fails `is_subset` on every later edit.
    const covered = (slug: string) =>
      SEED_BY_SCOPE.org.some((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(slug));
    for (const slug of [...SEED_BY_SCOPE.person, ...SEED_BY_SCOPE.team]) expect(covered(slug)).toBe(true);
  });

  it('pins models a harness actually asks for', () => {
    // `CLAUDE_API_AUTH_SPEC` asks for anthropic/claude-*, `CODEX_API_AUTH_SPEC` for openai/gpt-5*.
    // A pin nothing requests is a wallet that refuses every call it was created to serve — which is
    // exactly what `openai/codex-mini-latest` would have been: no slug in this repo names it.
    expect(SEED_BY_SCOPE.person).toContain('anthropic/claude-haiku-5.5');
    expect(SEED_BY_SCOPE.person).toContain('openai/gpt-5-mini');
  });
});

describe('aliasesForPinnedModel', () => {
  it('redirects a family onto the one model allowed in it — in both spellings of that family', () => {
    // Two keys, one target. The prefixed key catches a router slug (`anthropic/claude-sonnet-4.5`);
    // the bare one catches a client speaking the vendor's own API (`claude-sonnet-4-5`). `*` crosses
    // `/` in the hub's matcher, so the bare key can only ever match a bare request.
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'claude-*': 'anthropic/claude-haiku-4.5',
    });
  });

  it('handles one list spanning both harnesses — Claude Code and codex each get their own', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'claude-*': 'anthropic/claude-haiku-4.5',
      'openai/gpt-*': 'openai/gpt-5-mini',
      'gpt-*': 'openai/gpt-5-mini',
    });
  });

  it('never answers a request for one vendor with another vendor s model', () => {
    const aliases = aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini']);
    for (const [pattern, target] of Object.entries(aliases)) {
      // A bare key carries no vendor of its own; it is the same family, so compare on the family
      // word rather than the prefix.
      const family = pattern.includes('/') ? pattern.split('/')[1] : pattern;
      expect(target.split('/')[1]).toContain(family.replace('-*', ''));
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
      'claude-*': 'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-4.5': 'anthropic/claude-sonnet-4.5',
    });
  });

  it('mixes a pinned family with a wide-open one', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-*'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'claude-*': 'anthropic/claude-haiku-4.5',
    });
  });

  it('covers a model that did not exist when this was written', () => {
    expect(aliasesForPinnedModel(['anthropic/claude-something-new-9'])).toEqual({
      'anthropic/claude-*': 'anthropic/claude-something-new-9',
      'claude-*': 'anthropic/claude-something-new-9',
    });
  });

  it('redirects nothing for an empty list', () => {
    expect(aliasesForPinnedModel([])).toEqual({});
  });
});

describe('reconcileAliases', () => {
  const GEMINI = 'google/gemini-3.5-flash';

  it('keeps a redirect an admin wrote across families, which the derivation can never make', () => {
    const current = { 'anthropic/claude-*': GEMINI, 'claude-*': GEMINI };
    expect(reconcileAliases(current, [GEMINI])).toEqual({
      'anthropic/claude-*': GEMINI,
      'claude-*': GEMINI,
      'google/gemini-*': GEMINI,
      'gemini-*': GEMINI,
    });
  });

  it('still derives the same-family redirects, and drops the ones a wider list makes obsolete', () => {
    expect(reconcileAliases({}, [GEMINI])).toEqual(aliasesForPinnedModel([GEMINI]));
    // The wallet was widened back to the family glob: the old pin's redirect must go, not linger.
    expect(reconcileAliases({ 'google/gemini-*': GEMINI, 'gemini-*': GEMINI }, ['google/gemini-*'])).toEqual({});
  });

  it('keeps a redirect whose target is not the pinned model but is of the family the list allows', () => {
    // An org opened the family and a team pinned one model: the hub follows the redirect to the pin.
    const pinned = 'google/gemini-3.1-pro-preview';
    expect(reconcileAliases({ 'claude-*': GEMINI }, [pinned])).toEqual({
      'claude-*': GEMINI,
      ...aliasesForPinnedModel([pinned]),
    });
  });

  it('drops a hand-written redirect into a family the list does not allow at all', () => {
    expect(reconcileAliases({ 'claude-*': GEMINI }, ['openai/gpt-5-mini'])).toEqual(
      aliasesForPinnedModel(['openai/gpt-5-mini']),
    );
  });

  it('compares maps regardless of key order', () => {
    expect(sameAliases({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameAliases({ a: '1' }, { a: '2' })).toBe(false);
  });
});

describe('DEFAULT_MODELS', () => {
  it('is the cheap tier of BOTH families, and redirects each onto its own', () => {
    // The embedding model is there so a person's wallet can fund a RAG index; it is its own
    // family (`openai/text-*`), so it never captures a chat request.
    expect(DEFAULT_MODELS).toEqual([
      'anthropic/claude-haiku-5.5',
      'openai/gpt-5-mini',
      'openai/text-embedding-3-small',
    ]);
    // The narrowness is only safe BECAUSE the other tiers redirect onto it — and a redirect never
    // crosses vendors, so Claude Code and codex each land on the model of their own family.
    expect(aliasesForPinnedModel(DEFAULT_MODELS)).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-5.5',
      'claude-*': 'anthropic/claude-haiku-5.5',
      'openai/gpt-*': 'openai/gpt-5-mini',
      'gpt-*': 'openai/gpt-5-mini',
      'openai/text-*': 'openai/text-embedding-3-small',
      'text-*': 'openai/text-embedding-3-small',
    });
  });
});

/** What the hub serves for `provider-sizes`: one row per provider that declares sizes. */
const PROVIDER_SIZES = [
  {
    provider: 'openrouter',
    sm: 'anthropic/claude-haiku-5.5',
    md: 'anthropic/claude-sonnet-5.5',
    lg: 'anthropic/claude-opus-5.5',
  },
  { provider: 'openai', sm: 'openai/gpt-5-mini', md: 'openai/gpt-5', lg: 'openai/gpt-5-pro' },
  {
    provider: 'vertex',
    sm: 'google/gemini-3.5-flash-lite',
    md: 'google/gemini-3.5-flash',
    lg: 'google/gemini-3.1-pro-preview',
  },
];

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
  beforeEach(() => {
    h.providerSizes.mockReturnValue(PROVIDER_SIZES);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.save.mockResolvedValue(undefined);
    h.invalidate.mockResolvedValue(undefined);
  });

  it('shows a spinner until the endpoint itself has loaded', () => {
    h.endpoint.mockReturnValue(null);
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);
    expect(screen.queryByTestId('org-enabled')).toBeNull();
  });

  it('writes NOTHING when it renders a wallet with no models', async () => {
    // The bug this file used to pin as a feature. Seeding here made a restriction exist because
    // somebody opened the screen: a person nobody had looked at inherited the org's whole ceiling,
    // and the wallets the hub mints on first bootstrap were never seen by this page at all. The
    // initial list is chosen on the hub now (`_seed_models`), on every creation path.
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    await new Promise((r) => setTimeout(r, 0));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('shows an empty list as empty, not as the models it would inherit', () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);
    expect(screen.getByTestId('org-models').textContent).toBe('');
  });

  it('draws the verdict OVER the model list, out of flow, so the row cannot grow', async () => {
    // Rendered inline it wrapped this row's flex container onto a second line, and on a table every
    // row below shifted the moment somebody pressed test. The overlay is absolutely positioned, so
    // the row's height is the same before and after.
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['claude-haiku-4-5'], aliases: {} } }));
    h.verdict.mockReturnValue({ ok: true, status: 200, model: 'claude-haiku-4-5', latency_ms: 798, message: '' });
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    // The button renders no verdict of its own here — this row draws it somewhere the button cannot
    // reach, and two copies of one answer is the bug that would replace the old one.
    expect(screen.getByTestId(`stub-test-${UUID}`).getAttribute('data-inline-verdict')).toBe('false');
    expect(screen.queryByTestId('org-test-overlay')).toBeNull();

    fireEvent.click(screen.getByTestId(`stub-test-${UUID}`));

    const overlay = await screen.findByTestId('org-test-overlay');
    expect(overlay.className).toContain('absolute');
    expect(overlay.textContent).toContain('claude-haiku-4-5');
    expect(overlay.textContent).toContain('798ms');
    // Anchored to the model list, which is what "above the allowed models" means.
    expect(overlay.parentElement?.className).toContain('relative');
    expect(overlay.parentElement?.querySelector('[data-testid="org-models"]')).toBeTruthy();
  });

  it('shows a failed probe in the same overlay, in the failure tone', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['claude-haiku-4-5'], aliases: {} } }));
    h.verdict.mockReturnValue({ ok: false, status: 429, model: '', latency_ms: 0, message: 'limit exceeded' });
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId(`stub-test-${UUID}`));

    const overlay = await screen.findByTestId('org-test-overlay');
    expect(overlay.textContent).toContain('429');
    expect(overlay.getAttribute('title')).toContain('limit exceeded');
  });

  it('repairs a row that is pinned but has no redirect, without anyone touching it', async () => {
    // Every row pinned before aliasing existed. Re-typing the same model is a no-op at `commit`
    // and the empty-list seed never fires here, so if this did not self-heal the row would refuse
    // every `md`-tier caller forever.
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const filters = (h.save.mock.calls[0][2] as { filters: Record<string, unknown> }).filters;
    expect(filters.models_allow).toEqual(['anthropic/claude-haiku-4.5'], 'the pin itself is left alone');
    expect(filters.aliases).toEqual(aliasesForPinnedModel(['anthropic/claude-haiku-4.5']));
  });

  it('leaves a row alone once its redirect already matches its pin', () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: ['anthropic/claude-haiku-4.5'],
          aliases: aliasesForPinnedModel(['anthropic/claude-haiku-4.5']),
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('writes nothing on a team or an org row either — no scope seeds from here any more', async () => {
    for (const scope of ['team', 'org'] as const) {
      h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: [] } }));
      render(<EndpointControls endpointId={TYPE_ID} scope={scope} testIdPrefix={scope} manage />);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.save, `${scope} row wrote on render`).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('does not seed a wallet that already has models', () => {
    // Its redirect already matches its pin, so there is nothing to seed and nothing to repair.
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: ['anthropic/claude-opus-4'],
          aliases: aliasesForPinnedModel(['anthropic/claude-opus-4']),
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('shows the models already on the wallet, and the default only as a placeholder otherwise', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-*', 'openai/gpt-4*'] } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);
    expect(screen.getByTestId('org-models').textContent).toBe('anthropic/claude-*, openai/gpt-4*');
  });

  it('saves an edited model list as a full filters PUT, leaving other filter fields untouched', async () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: DEFAULT_MODELS,
          // Derived, never spelled: a hand-written map goes stale the moment the default gains a
          // family, and a stale map makes the repair effect fire a save this test does not expect.
          aliases: aliasesForPinnedModel(DEFAULT_MODELS),
          streaming: 'require',
          max_tokens_ceiling: 4096,
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

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
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models'));
    fireEvent.change(screen.getByTestId('org-models-input'), {
      target: { value: 'anthropic/claude-haiku-4.5' },
    });
    fireEvent.blur(screen.getByTestId('org-models-input'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const filters = (h.save.mock.calls[0][2] as { filters: Record<string, unknown> }).filters;
    expect(filters.models_allow).toEqual(['anthropic/claude-haiku-4.5']);
    // A machine configured for sonnet now transparently receives haiku — whichever spelling of the
    // family it asks in, since a client on Anthropic's own API names no vendor prefix at all.
    expect(filters.aliases).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'claude-*': 'anthropic/claude-haiku-4.5',
    });
  });

  it.each([
    ['a team', 'team' as const, 'team-1'],
    ['a member', 'person' as const, 'member-1'],
  ])('writes the models it shows when %s row is edited', async (_label, scope, prefix) => {
    // The bug this pins: the page used to DISPLAY a model list for a level it never saved — an
    // empty team row printed the constant, so the screen said haiku while the hub held nothing and
    // everyone under that team inherited the organisation's whole list instead. What is typed here
    // must reach the hub, for a team exactly as for a person.
    h.endpoint.mockReturnValue(
      endpoint({ filters: { models_allow: [], aliases: {}, streaming: 'allow', max_tokens_ceiling: null } }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope={scope} testIdPrefix={prefix} manage />);

    fireEvent.click(screen.getByTestId(`${prefix}-models`));
    fireEvent.change(screen.getByTestId(`${prefix}-models-input`), {
      target: { value: 'anthropic/claude-haiku-4.5, openai/gpt-5-mini' },
    });
    fireEvent.blur(screen.getByTestId(`${prefix}-models-input`));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][0].toString()).toBe(TYPE_ID);
    expect((h.save.mock.calls[0][2] as { filters: Record<string, unknown> }).filters).toEqual({
      models_allow: ['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini'],
      // The redirects go with it, or a machine set to sonnet is refused by the very row that was
      // just pinned for it.
      aliases: aliasesForPinnedModel(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini']),
      streaming: 'allow',
      max_tokens_ceiling: null,
    });
    // And the screen re-reads, so a team edit that moved anything shows without a manual refresh.
    await waitFor(() => expect(h.invalidate).toHaveBeenCalled());
    expect(h.refetchEndpoints).toHaveBeenCalled();
  });

  it('refuses to save an edit that would leave the field empty', async () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: DEFAULT_MODELS,
          aliases: aliasesForPinnedModel(DEFAULT_MODELS),
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models'));
    fireEvent.change(screen.getByTestId('org-models-input'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByTestId('org-models-input'));

    // The one call left standing is the seed check, which found the field already non-empty.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-models').textContent).toBe(DEFAULT_MODELS.join(', '));
  });

  it('adds a vendor family from one press, and chains a second onto it', async () => {
    h.endpoint.mockReturnValue(
      endpoint({ filters: { models_allow: ['anthropic/claude-*'], aliases: {}, streaming: 'require' } }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models-add-gemini'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    // A whole-object filters PUT again: the other filter fields must survive a preset press.
    expect(h.save.mock.calls[0][2]).toEqual({
      filters: { models_allow: ['anthropic/claude-*', 'google/gemini-*'], aliases: {}, streaming: 'require' },
    });
  });

  it('starts a list from a family when the row had none of its own', async () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models-add-openai'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect((h.save.mock.calls[0][2] as { filters: { models_allow: string[] } }).filters.models_allow).toEqual([
      'openai/*',
    ]);
  });

  it('does not offer a family the list already holds', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['google/gemini-*'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);
    expect(screen.getByTestId<HTMLButtonElement>('org-models-add-gemini').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('org-models-add-anthropic').disabled).toBe(false);
  });

  it('keeps Clear pressable on a row that inherits, where it saves an empty list', async () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);

    const clear = screen.getByTestId<HTMLButtonElement>('org-models-clear');
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect((h.save.mock.calls[0][2] as { filters: { models_allow: string[] } }).filters.models_allow).toEqual([]);
  });

  it('writes every model the provider offers into the list when All is pressed, and says so in its tooltip', async () => {
    h.endpoint.mockReturnValue(
      endpoint({ filters: { models_allow: ['anthropic/claude-*'], aliases: {}, streaming: 'require' } }),
    );
    h.listModels.mockResolvedValue([
      { id: 'anthropic/claude-sonnet-5.5' },
      { id: 'google/gemini-3.5-flash' },
      { id: 'openai/gpt-5-mini' },
    ]);
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);

    const all = screen.getByTestId('org-models-all');
    expect(all.getAttribute('title')).toBe('Puts everything that is available on OpenRouter');
    fireEvent.click(all);

    // Two writes: the row is cleared first, so the `models` action answers with the whole catalog
    // the budget above allows; then exactly that catalog is written, with no redirect derived from it.
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.save.mock.calls[0][2]).toEqual({ filters: { models_allow: [], aliases: {}, streaming: 'require' } });
    expect(h.save.mock.calls[1][2]).toEqual({
      filters: {
        models_allow: ['anthropic/claude-sonnet-5.5', 'google/gemini-3.5-flash', 'openai/gpt-5-mini'],
        aliases: {},
        streaming: 'require',
      },
    });
  });

  it('clears the models AND the hand-written redirects when Clear is pressed', async () => {
    h.endpoint.mockReturnValue(
      endpoint({
        filters: {
          models_allow: ['google/gemini-3.1-pro-preview'],
          // Complete already (derived pair + the hand-written one), so the mount-time repair has nothing to do.
          aliases: {
            'google/gemini-*': 'google/gemini-3.1-pro-preview',
            'gemini-*': 'google/gemini-3.1-pro-preview',
            'claude-*': 'google/gemini-3.1-pro-preview',
          },
          max_tokens_ceiling: 4096,
        },
      }),
    );
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models-clear'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][2]).toEqual({
      filters: { models_allow: [], aliases: {}, max_tokens_ceiling: 4096 },
    });
  });

  it('writes a team the three exact sizes of a family instead of a glob', async () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="team" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models-add-anthropic'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const saved = (h.save.mock.calls[0][2] as { filters: { models_allow: string[] } }).filters.models_allow;
    expect(saved).toEqual(['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5']);
  });

  it('chains the sizes of a second family onto the first on a team', async () => {
    const claude = ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5'];
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: claude, aliases: aliasesForPinnedModel(claude) } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="team" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models-add-gemini'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect((h.save.mock.calls[0][2] as { filters: { models_allow: string[] } }).filters.models_allow).toEqual([
      ...claude,
      'google/gemini-3.5-flash-lite',
      'google/gemini-3.5-flash',
      'google/gemini-3.1-pro-preview',
    ]);
  });

  it('leaves a team family button disabled, and says why, while the hub has declared no sizes for it', () => {
    h.providerSizes.mockReturnValue(undefined);
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="team" testIdPrefix="org" manage />);

    const button = screen.getByTestId<HTMLButtonElement>('org-models-add-anthropic');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('No sizes are declared for Anthropic');
  });

  it('keeps the org on the family glob, which opens the family rather than listing it', async () => {
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="org" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByTestId('org-models-add-gemini'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect((h.save.mock.calls[0][2] as { filters: { models_allow: string[] } }).filters.models_allow).toEqual([
      'google/gemini-*',
    ]);
  });

  it('flips enabled through the switch', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: DEFAULT_MODELS }, enabled: true }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(h.save).toHaveBeenCalledWith(expect.anything(), [], { enabled: false }));
  });

  it('renders the Test button for this endpoint', () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: DEFAULT_MODELS } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);
    expect(screen.getByTestId(`stub-test-${UUID}`)).toBeTruthy();
  });
});

/**
 * `manage={false}` — the state an ORG ADMIN is in on the organization's own row, where the hub
 * answers `can_configure: false`.
 *
 * The half that is not cosmetic is the seed. This component REPAIRS the row it renders, by writing
 * to it on mount; for someone who may only read, that is a request the hub refuses and an error
 * toast on every single render. Disabling the visible controls without stopping the seed would
 * have left exactly that.
 */
describe('EndpointControls — read-only', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.save.mockResolvedValue(undefined);
    h.invalidate.mockResolvedValue(undefined);
  });

  it('never writes on mount, even on a wallet that would otherwise be repaired', async () => {
    // An empty `models_allow` on a person row is precisely the shape the seed fires on.
    h.endpoint.mockReturnValue(endpoint());
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage={false} />);

    await waitFor(() => expect(screen.getByTestId('org-enabled')).toBeTruthy());
    expect(h.save).not.toHaveBeenCalled();
  });

  it('still repairs it for someone who may configure it — the guard is the flag, not the row', async () => {
    // Stated on a PINNED row with no redirect, because that is the only thing this screen repairs
    // now: an empty row is left to inherit, and its initial list is the hub's to choose.
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    await waitFor(() => expect(h.save).toHaveBeenCalled());
  });

  it('disables the enable switch and the models field', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage={false} />);

    const models = await screen.findByTestId<HTMLButtonElement>('org-models');
    expect(models.disabled).toBe(true);
    // The switch is a button with aria-disabled/disabled depending on the primitive; either way it
    // must not be operable.
    const enabled = screen.getByTestId('org-enabled').querySelector('button');
    expect(enabled?.hasAttribute('disabled') || enabled?.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('offers no preset buttons to someone who may not change the row', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage={false} />);

    await screen.findByTestId('org-models');
    expect(screen.queryByTestId('org-model-presets')).toBeNull();
  });

  it('does not open the models editor when the field is clicked', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage={false} />);

    fireEvent.click(await screen.findByTestId('org-models'));
    expect(screen.queryByTestId('org-models-input')).toBeNull();
  });
});

describe('withModelEntries', () => {
  it('appends entries in order, once each, keeping what the admin built', () => {
    expect(withModelEntries([], ['anthropic/claude-*'])).toEqual(['anthropic/claude-*']);
    expect(withModelEntries(['anthropic/claude-*'], ['google/gemini-*'])).toEqual([
      'anthropic/claude-*',
      'google/gemini-*',
    ]);
    expect(withModelEntries(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('presetEntries', () => {
  const anthropic = MODEL_FAMILY_PRESETS.find((p) => p.key === 'anthropic')!;

  it('is the glob on the org, whatever the hub declares', () => {
    expect(presetEntries(anthropic, 'org', undefined)).toEqual(['anthropic/claude-*']);
  });

  it('is the three sizes, small to large, of the provider whose sizes belong to the family', () => {
    expect(presetEntries(anthropic, 'team', PROVIDER_SIZES)).toEqual([
      'anthropic/claude-haiku-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-opus-5.5',
    ]);
    for (const preset of MODEL_FAMILY_PRESETS) {
      const entries = presetEntries(preset, 'team', PROVIDER_SIZES);
      expect(entries).toHaveLength(3);
      expect(entries!.some((slug) => slug.includes('*'))).toBe(false);
    }
  });

  it('is null while the sizes load, and for a family no provider declares sizes in', () => {
    expect(presetEntries(anthropic, 'team', undefined)).toBeNull();
    expect(presetEntries(anthropic, 'team', [PROVIDER_SIZES[2]])).toBeNull();
  });
});
