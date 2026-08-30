import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FLOWPAD-1993.
 *
 * `openNewChat` awaits this helper with no catch of its own, and two of its
 * callers invoke it as `void openNewChat(...)` — record-type-nav's Fork with no
 * `.catch` at all, ChatsNavigator's with a `.catch` that opens the Capabilities
 * view. So a rejection escaping this helper becomes either an unhandled
 * rejection or a bogus "your harness is missing" prompt. Never throwing is the
 * contract, not an implementation detail.
 *
 * The resolution shape is the other load-bearing part: `vibe` shipped a bug
 * where a bare-name lookup matched a launchable `Agent` sharing the name and
 * every session silently ran a generic prompt. These pin the (name, scope)
 * filter so the same class of collision can't reach `standard`.
 */

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));
// The listing lives in vibe-personas, which imports the client as `@sdk/client`'s
// default export; the SDK barrel re-exports it as `apiClient`. Mock both spellings.
vi.mock('@sdk/client', () => ({ default: apiMock }));
vi.mock('@sdk', () => ({ apiClient: apiMock, AgentKind: { Vibe: 'vibe' } }));

/**
 * The resolved ref is cached in a module-level variable, so every test needs a
 * fresh module instance or the first resolve leaks into the rest.
 */
async function freshEmbed() {
  vi.resetModules();
  return (await import('@src/navigation/embed-standard-agent')).embedStandardAgent;
}

function fakeProcess() {
  return { loadEmbeddedSubagent: vi.fn().mockResolvedValue(undefined) } as any;
}

describe('embedStandardAgent', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('embeds the system-scoped `standard` subagent by its asset_ref path', async () => {
    apiMock.get.mockResolvedValue([
      { name: 'standard', scope: 'project', asset_ref: '/proj/.claude/agents/standard.md' },
      { name: 'vibe', scope: 'system', asset_ref: '/sdk/.claude/agents/vibe.md' },
      { name: 'standard', scope: 'system', asset_ref: '/sdk/.claude/agents/standard.md' },
    ]);
    const embed = await freshEmbed();
    const proc = fakeProcess();

    await embed(proc);

    // The system asset, NOT the same-named project one that would shadow it,
    // and not the same-scoped `vibe` one.
    expect(proc.loadEmbeddedSubagent).toHaveBeenCalledWith('/sdk/.claude/agents/standard.md');
  });

  it('queries the subagent route with system assets included', async () => {
    apiMock.get.mockResolvedValue([]);
    const embed = await freshEmbed();

    await embed(fakeProcess());

    // System (SDK-shipped) agents only surface with include_system=true, and the
    // subagent route is what disambiguates from the launchable `agent` type.
    expect(apiMock.get).toHaveBeenCalledWith('/graph/subagent?include_system=true');
  });

  it('reuses the resolved ref across calls', async () => {
    apiMock.get.mockResolvedValue([
      { name: 'standard', scope: 'system', asset_ref: '/sdk/.claude/agents/standard.md' },
    ]);
    const embed = await freshEmbed();

    await embed(fakeProcess());
    await embed(fakeProcess());

    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it('retries the lookup after a miss, so a late-indexed agent is picked up', async () => {
    apiMock.get.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { name: 'standard', scope: 'system', asset_ref: '/sdk/.claude/agents/standard.md' },
    ]);
    const embed = await freshEmbed();

    await embed(fakeProcess());
    const second = fakeProcess();
    await embed(second);

    expect(apiMock.get).toHaveBeenCalledTimes(2);
    expect(second.loadEmbeddedSubagent).toHaveBeenCalledWith('/sdk/.claude/agents/standard.md');
  });

  it('degrades without throwing when the agent is not indexed', async () => {
    apiMock.get.mockResolvedValue([]);
    const embed = await freshEmbed();
    const proc = fakeProcess();

    await expect(embed(proc)).resolves.toBeUndefined();

    expect(proc.loadEmbeddedSubagent).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('degrades without throwing when the lookup fails', async () => {
    apiMock.get.mockRejectedValue(new Error('graph unreachable'));
    const embed = await freshEmbed();

    await expect(embed(fakeProcess())).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalled();
  });

  it('degrades without throwing when the embed itself fails', async () => {
    apiMock.get.mockResolvedValue([
      { name: 'standard', scope: 'system', asset_ref: '/sdk/.claude/agents/standard.md' },
    ]);
    const embed = await freshEmbed();
    const proc = { loadEmbeddedSubagent: vi.fn().mockRejectedValue(new Error('500')) } as any;

    await expect(embed(proc)).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalled();
  });
});
