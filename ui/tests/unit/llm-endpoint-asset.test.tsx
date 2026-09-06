/**
 * The LLM endpoint as a USER-SCOPED asset.
 *
 * Two contracts, and both are about whose budget is on screen:
 *  - `myEndpoints` lists ONLY what the hub allocated to this person. An owner sees a great
 *    deal more than that — the org pool, its teams' pools, every allowance they minted for
 *    somebody else — and none of it is their budget. So the test is `principal_typeid ===
 *    user-<me>`, not "anything that isn't a group".
 *  - the view is READ-ONLY and shows the endpoint's own ceilings and models — never
 *    `member_default_limits`, which is the template an org hands its members and says
 *    nothing about this wallet — plus the same Test button the org page's rows carry.
 *
 * And one about whose KEY is on screen: a green tick proves a call worked, not what paid for
 * it. The provenance block under the button names the root the hub spends, states that this
 * machine's OAuth logins and stored keys are never used for it, and — separately, because the
 * two legitimately disagree — says what the local harnesses are actually running on.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  test: vi.fn(),
  chain: vi.fn(),
  probeHarnesses: vi.fn(),
  endpoint: null as unknown,
  isLoading: false,
  status: null as unknown,
  // Per-worker capability warning: a string means the check ran and the harness is NOT on
  // this machine. All null = nothing known = nothing hidden (the shared fail-open rule).
  warnings: {} as Record<string, string | null>,
}));

vi.mock('@src/components/llm-sources/use-llm-sources', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmSources: () => ({ status: h.status, isLoading: false }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isHubOnly: () => false,
  llmSourcesService: { test: h.test, chain: h.chain, status: vi.fn() },
}));
vi.mock('@src/components/workers/harness-availability', () => ({
  useHarnessAvailability: () => ({ warnings: h.warnings, probeHarnesses: h.probeHarnesses }),
}));

import { LlmEndpointAssetView } from '@src/components/assets/editor/llm-endpoint/LlmEndpointAssetView';
import { isAllocatedToUser, myEndpoints } from '@src/components/llm-endpoints/my-endpoints';
import type { LLMEndpointOffer } from '@sdk';

vi.mock('@src/components/llm-endpoints/my-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyEndpoint: () => ({ endpoint: h.endpoint, isLoading: h.isLoading }),
}));

/** The provenance block reads the chain through react-query, so the view needs a client. */
function renderView(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function offer(over: Partial<LLMEndpointOffer> = {}): LLMEndpointOffer {
  return {
    id: 'ep-1',
    name: 'My budget',
    provider: 'openrouter',
    enabled: true,
    credential_hint: '',
    system_default: false,
    invoke_path: '/api/v1/graph/llm_endpoint/ep-1/invoke',
    kind: 'hub',
    secret_name: '',
    models: {},
    invocable: true,
    base_url: '',
    principal_typeid: 'user-abc',
    can_administer: null,
    filters: {
      models_allow: ['anthropic/claude-haiku-4.5'],
      models_deny: [],
      max_tokens_ceiling: null,
      max_input_chars: null,
      temperature_max: null,
      top_p_max: null,
      betas_allow: null,
      streaming: 'allow',
      paths_allow: ['v1/**'],
      aliases: {},
      model_map: {},
    },
    limits: {
      tokens_total: null,
      tokens_per_day: null,
      tokens_per_week: null,
      tokens_per_month: null,
      cost_usd_total: 25,
      cost_usd_per_day: null,
      cost_usd_per_week: null,
      cost_usd_per_month: null,
      requests_per_minute: null,
    },
    ...over,
  };
}

describe('myEndpoints', () => {
  const ME = 'user-abc';

  it('lists what is stamped with this person AND what was handed to them', () => {
    const mine = offer({ id: 'mine', name: 'Mine', principal_typeid: ME });
    const alsoMine = offer({ id: 'also', name: 'Also mine', principal_typeid: 'user:abc' });
    // Handed over by an admin: `allocate` stamps no principal and grants `reader`, so the ONLY
    // thing saying it is theirs is that they cannot change it. This is the row that used to
    // vanish — a person's entire Assets tree showed no LLM Endpoints at all.
    const givenToMe = offer({ id: 'given', name: 'Gadi +20', principal_typeid: null, can_administer: false });
    // Everything below is visible to an OWNER and is still not their budget.
    const someoneElse = offer({ id: 'theirs', name: 'Bob +5', principal_typeid: 'user-bob' });
    const iAdminister = offer({ id: 'admin', name: 'Gadi +1', principal_typeid: null, can_administer: true });
    const sharedRoot = offer({ id: 'root', name: 'Global root', principal_typeid: null, can_administer: null });
    const org = offer({ id: 'org', name: 'Acme', principal_typeid: 'organization-1' });
    const team = offer({ id: 'team', name: 'Platform', principal_typeid: 'team-9' });

    const kept = myEndpoints({
      available: [org, mine, team, someoneElse, iAdminister, sharedRoot, givenToMe, alsoMine],
      hub_user_typeid: ME,
    } as never);

    // Sorted by name; the colon spelling of the same id counts as mine.
    expect(kept.map((e) => e.id)).toEqual(['also', 'given', 'mine']);
    expect(isAllocatedToUser(someoneElse, ME)).toBe(false);
    expect(isAllocatedToUser(iAdminister, ME)).toBe(false);
    // Unknown is not a gift: the shared root reaches everyone without a role edge, and counting
    // it would put the company pool in every personal list.
    expect(isAllocatedToUser(sharedRoot, ME)).toBe(false);
    expect(isAllocatedToUser(org, ME)).toBe(false);
    expect(isAllocatedToUser(team, ME)).toBe(false);
  });

  it('keeps a stamped wallet whatever the caller may do to it', () => {
    // An admin CAN change their own default; the stamp is what makes it theirs, so the role
    // question is never asked of a tagged row.
    const mineAndEditable = offer({ principal_typeid: ME, can_administer: true });
    expect(isAllocatedToUser(mineAndEditable, ME)).toBe(true);
  });

  it('claims nothing when the box cannot say who this person is', () => {
    // Signed out (or an older backend that does not report it): "mine" is unprovable, and
    // guessing would show somebody else's wallet.
    const mine = offer({ principal_typeid: ME });
    expect(myEndpoints({ available: [mine], hub_user_typeid: null } as never)).toEqual([]);
    expect(myEndpoints(null)).toEqual([]);
  });
});

describe('LlmEndpointAssetView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isLoading = false;
    h.endpoint = offer();
    h.status = null;
    h.warnings = { claude_code: null, codex: null, copilot: null, opencode: null };
    h.chain.mockResolvedValue({
      entry: { id: 'llm_endpoint-ep-1', name: 'My budget' },
      hops: [
        { id: 'llm_endpoint-ep-1', name: 'My budget', provider: null, is_root: false, has_credential: false },
        { id: 'llm_endpoint-root', name: 'Acme pool', provider: 'openrouter', is_root: true, has_credential: true },
      ],
      paths: [['llm_endpoint-ep-1', 'llm_endpoint-root']],
      missing_sources: [],
      sticky_root_for_me: null,
    });
  });
  afterEach(() => cleanup());

  it('shows the budget and the models this person may spend, read-only', () => {
    renderView(<LlmEndpointAssetView value="llm_endpoint-ep-1" />);

    expect(screen.getByTestId('llm-asset-name').textContent).toContain('My budget');
    expect(screen.getByTestId('llm-asset-limit-cost_usd_total').textContent).toContain('$25');
    expect(screen.getByTestId('llm-asset-models-allow').textContent).toContain('anthropic/claude-haiku-4.5');
    // Nothing that edits, deletes, shares or re-budgets: the hub owns all of that.
    expect(screen.queryByTestId('llm-detail-edit')).toBeNull();
    expect(screen.queryByTestId('llm-detail-share')).toBeNull();
  });

  it('carries the same Test button as the org page, and tests through the BOX', async () => {
    h.test.mockResolvedValue({ ok: true, status: 200, model: 'm', latency_ms: 7, message: '' });
    renderView(<LlmEndpointAssetView value="llm_endpoint-ep-1" />);

    await userEvent.click(screen.getByTestId('llm-test-ep-1'));

    // On a desktop the hub's own `/graph/llm_endpoint/<id>/test` is a 404 — the type has no
    // local rows — so the verdict must come through the box action instead.
    expect(h.test).toHaveBeenCalledWith('ep-1');
    expect((await screen.findByTestId('llm-test-verdict-ep-1')).textContent).toContain('7ms');
  });

  it('says so plainly when the id is not one of the budgets you hold', () => {
    h.endpoint = null;
    renderView(<LlmEndpointAssetView value="llm_endpoint-gone" />);
    expect(screen.getByTestId('llm-asset-missing')).toBeTruthy();
  });
});

describe('FundingProvenance — what the tick actually proves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isLoading = false;
    h.endpoint = offer();
    h.status = null;
    h.warnings = { claude_code: null, codex: null, copilot: null, opencode: null };
    h.chain.mockResolvedValue({
      entry: { id: 'llm_endpoint-ep-1', name: 'My budget' },
      hops: [
        { id: 'llm_endpoint-ep-1', name: 'My budget', provider: null, is_root: false, has_credential: false },
        { id: 'llm_endpoint-root', name: 'Acme pool', provider: 'openrouter', is_root: true, has_credential: true },
      ],
      paths: [['llm_endpoint-ep-1', 'llm_endpoint-root']],
      missing_sources: [],
      sticky_root_for_me: null,
    });
  });
  afterEach(() => cleanup());

  it('names the root whose key pays, and rules out this machine’s own credentials', async () => {
    renderView(<LlmEndpointAssetView value="llm_endpoint-ep-1" />);

    // The chain ends at the root that holds the key — an allocation names the pool above it
    // rather than implying it holds one itself.
    expect((await screen.findByTestId('llm-funding-root')).textContent).toContain('Acme pool');
    expect(screen.getByTestId('llm-funding-root').textContent).toContain('openrouter');
    // The claim that makes a green tick mean something, stated whether or not a test has run.
    const transport = screen.getByTestId('llm-funding-transport').textContent ?? '';
    expect(transport).toContain('OAuth');
    expect(transport).toContain('never used');
  });

  it('reports the model and status the run actually used, under the button', async () => {
    h.test.mockResolvedValue({
      ok: true,
      status: 200,
      model: 'anthropic/claude-haiku-4.5',
      latency_ms: 408,
      message: '',
    });
    renderView(<LlmEndpointAssetView value="llm_endpoint-ep-1" />);

    await userEvent.click(screen.getByTestId('llm-test-ep-1'));

    const line = (await screen.findByTestId('llm-funding-verdict')).textContent ?? '';
    expect(line).toContain('anthropic/claude-haiku-4.5');
    expect(line).toContain('200');
    expect(line).toContain('408ms');
  });

  it('lists only the assistants that are actually on this machine', async () => {
    // The resolver answers for every harness it knows, installed or not — and when a harness
    // has no usable device login the ladder falls to this budget, so an absent Copilot would
    // otherwise be reported as running on the wallet you are looking at.
    const picked = (id: string) => ({ endpoint_typeid: `llm_endpoint-${id}`, name: id });
    h.warnings = { claude_code: null, codex: null, copilot: 'not installed', opencode: 'not installed' };
    h.status = {
      available: [],
      endpoint_typeid: null,
      invoke_url: null,
      name: null,
      provider: null,
      hub_logged_in: true,
      hub_user_typeid: 'user-abc',
      sources: {
        'harness.claude.cli': [],
        'harness.codex.cli': [],
        'harness.copilot.cli': [],
        'harness.opencode.cli': [],
      },
      resolved: {
        'harness.claude.cli': picked('ep-1'),
        'harness.codex.cli': picked('ep-1'),
        'harness.copilot.cli': picked('ep-1'),
        'harness.opencode.cli': picked('ep-1'),
      },
      endpoints: { 'llm_endpoint-ep-1': offer() },
      active_for: [],
    };
    renderView(<LlmEndpointAssetView value="llm_endpoint-ep-1" />);

    expect(await screen.findByTestId('llm-funding-harness.claude.cli')).toBeTruthy();
    expect(screen.getByTestId('llm-funding-harness.codex.cli')).toBeTruthy();
    expect(screen.queryByTestId('llm-funding-harness.copilot.cli')).toBeNull();
    expect(screen.queryByTestId('llm-funding-harness.opencode.cli')).toBeNull();
    // Asking is the point: the app subscribes with autoCheck:false, so an unprobed harness
    // would read "unknown" forever and nothing would ever be filtered.
    expect(h.probeHarnesses).toHaveBeenCalled();
  });

  it('separately says what the local harnesses are on — the thing a passing test does NOT prove', async () => {
    // The endpoint tests green while the machine's own Claude runs on a vendor OAuth login.
    // Conflating the two is exactly the confusion this block exists to end.
    h.status = {
      available: [],
      endpoint_typeid: null,
      invoke_url: null,
      name: null,
      provider: null,
      hub_logged_in: true,
      hub_user_typeid: 'user-abc',
      sources: { 'harness.claude.cli': [] },
      resolved: { 'harness.claude.cli': { endpoint_typeid: 'llm_endpoint-dev', name: 'Claude login' } },
      endpoints: {
        'llm_endpoint-dev': offer({ id: 'dev', name: 'Claude', provider: 'anthropic', kind: 'device' }),
      },
      active_for: [],
    };
    renderView(<LlmEndpointAssetView value="llm_endpoint-ep-1" />);

    const row = await screen.findByTestId('llm-funding-harness.claude.cli');
    expect(row.textContent).toContain('OAuth login');
    expect(row.textContent).not.toContain('this budget');
  });
});
