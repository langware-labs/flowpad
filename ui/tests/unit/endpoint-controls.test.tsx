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
  models: vi.fn(),
  verdict: vi.fn(),
}));

vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmEndpoint: (...args: unknown[]) => h.endpoint(...args),
  // The row re-reads the endpoints after a save, because a TEAM edit moves the members' lists on
  // the hub and nothing tells this client about writes it did not make.
  useLlmEndpoints: () => ({ endpoints: [], isLoading: false, refetch: h.refetchEndpoints, error: null }),
  // Only an INHERITING row reaches this — every row on the budgets page mounts one of these, so it
  // is deliberately not an unconditional read. `h.models` therefore doubles as the assertion that
  // the fan-out is bounded: a row with its own list must never call it.
  useLlmEndpointModels: (...args: unknown[]) => h.models(...args),
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
  };
});
// Its own dedicated suite covers the call/verdict cycle; here it only needs to exist so the row
// renders — asserting on its testid is enough to know it is actually wired in.
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
  /** These are a HINT now, not a write: the hub chooses what a new wallet allows
   *  (`_seed_models` / `MEMBER_DEFAULT_MODELS` in `flowpad/hub/builtin/llm_endpoint.py`), because it
   *  is also what mints a person's default on their first bootstrap — a path this screen is not on,
   *  and the reason a person used to be restricted only if an admin had opened the page. Kept in
   *  step by hand, like the asset-editor contract: drift shows up as a stale placeholder, never as
   *  a wrong value on a row. */
  it('mirrors the hub: a ceiling on the org, the cheap tier below it', () => {
    expect(SEED_BY_SCOPE.org).toEqual(['anthropic/claude-*', 'openai/*']);
    expect(SEED_BY_SCOPE.person).toEqual(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini']);
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
    expect(SEED_BY_SCOPE.person).toContain('anthropic/claude-haiku-4.5');
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

describe('DEFAULT_MODELS', () => {
  it('is the cheap tier of BOTH families, and redirects each onto its own', () => {
    expect(DEFAULT_MODELS).toEqual(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini']);
    // The narrowness is only safe BECAUSE the other tiers redirect onto it — and a redirect never
    // crosses vendors, so Claude Code and codex each land on the model of their own family.
    expect(aliasesForPinnedModel(DEFAULT_MODELS)).toEqual({
      'anthropic/claude-*': 'anthropic/claude-haiku-4.5',
      'claude-*': 'anthropic/claude-haiku-4.5',
      'openai/gpt-*': 'openai/gpt-5-mini',
      'gpt-*': 'openai/gpt-5-mini',
    });
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

  // Before, not after: the FIRST test needs the default too, and the hook this stands in for always
  // returns a query object.
  beforeEach(() => {
    // The quiet default: nothing inherited to show. Tests about the inherited list say so.
    h.models.mockReturnValue({ data: undefined, isLoading: false });
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

  it('names the models an empty row INHERITS, instead of saying that it inherits', () => {
    // An empty list is not "no models" — it is every model the chain above allows, and that list is
    // one action away. Saying "inherits the budget above" told the reader where to look instead of
    // answering the question they had.
    h.endpoint.mockReturnValue(endpoint());
    h.models.mockReturnValue({
      data: [
        { id: 'claude-haiku-4-5', root_id: 'r1' },
        { id: 'claude-sonnet-4-5', root_id: 'r1' },
      ],
      isLoading: false,
    });
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    expect(screen.getByTestId('org-models').textContent).toBe('claude-haiku-4-5, claude-sonnet-4-5');
    expect(screen.getByTestId('org-models').textContent).not.toContain('inherits');
    // Trimmed to keep the probe on the same row, so the whole list rides in the tooltip.
    expect(screen.getByTestId('org-models').getAttribute('title')).toContain('claude-haiku-4-5, claude-sonnet-4-5');
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

  it('reads the inherited list ONLY for a row that actually inherits', () => {
    // Every row on the budgets page mounts one of these. An unconditional read would be a per-row
    // fan-out across every team and every person — the cost `BudgetSection` opens its people lists
    // lazily to avoid.
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['claude-haiku-4-5'], aliases: {} } }));
    h.models.mockReturnValue({ data: undefined, isLoading: false });
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    // The hook still RUNS (it is a hook), but it is passed no id, which is what disables the query.
    expect(h.models).toHaveBeenCalledWith(undefined);
  });

  it('falls back to the old wording when there is no list to print at all', () => {
    // The read failed, or the chain above allows nothing this row can name. Printing an empty
    // string there would read as "no models", which is the opposite of what an empty list means.
    h.endpoint.mockReturnValue(endpoint());
    h.models.mockReturnValue({ data: [], isLoading: false });
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage />);

    expect(screen.getByTestId('org-models').textContent).toContain('inherits');
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

  it('does not open the models editor when the field is clicked', async () => {
    h.endpoint.mockReturnValue(endpoint({ filters: { models_allow: ['anthropic/claude-haiku-4.5'], aliases: {} } }));
    render(<EndpointControls endpointId={TYPE_ID} scope="person" testIdPrefix="org" manage={false} />);

    fireEvent.click(await screen.findByTestId('org-models'));
    expect(screen.queryByTestId('org-models-input')).toBeNull();
  });
});
