/**
 * `useOAuthConnection` — the two invariants the client used to break.
 *
 * 1. **Detaching the last project is not a delete.** Both backends deliberately
 *    keep the credential when `remaining_attachment_count` reaches 0 (flow_sdk
 *    `detach_action`; the hub logs "not auto-disconnecting. Use disconnect
 *    action"). The hook used to chain straight into `disconnect()` at exactly
 *    that moment, destroying a token the server had just decided to keep.
 * 2. **No project is not "no credential".** Status was gated on having BOTH the
 *    user table and a project table, so with nothing selected every provider
 *    reported DISCONNECTED — the table denied credentials the user was holding.
 */
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  detach: vi.fn(),
  disconnect: vi.fn(),
  attach: vi.fn(),
  userTable: { values: [] as unknown[] },
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  oauthService: { detach: h.detach, disconnect: h.disconnect, attach: h.attach },
  dataContext: { userTypeId: { type: 'user', id: 'u1', toString: () => 'user-u1' } },
}));
// Only the user has a table; the project query stays empty, which is the
// zero-project case this file is about.
vi.mock('@sdk/react/hooks/useEntityEnv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEntityEnv: ({ entityTypeId }: { entityTypeId?: { type: string } }) => ({
    table: entityTypeId?.type === 'user' ? h.userTable : undefined,
    isLoading: false,
  }),
}));

import { ConnectionStatus } from '@sdk';
import { useOAuthConnection } from '@sdk/react/hooks/useOAuthConnection';

const PROJECT = { type: 'project', id: 'p1', toString: () => 'project-p1' } as never;

/** A user's held, usable GitHub credential, as the env table reports it. */
const HELD_GITHUB = {
  name: 'github',
  description: 'OAuth integration for GitHub',
  var_type: 'oauth_provider',
  ref_name: 'github_token',
  var_status: 'AVAILABLE',
};

function mount(projectTypeId?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const captured: { current: ReturnType<typeof useOAuthConnection> | null } = { current: null };
  const Probe = () => {
    captured.current = useOAuthConnection({ projectTypeId: projectTypeId as never });
    return null;
  };
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return captured;
}

describe('useOAuthConnection — detaching the last project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userTable = { values: [HELD_GITHUB] };
    h.detach.mockResolvedValue({ remaining_attachment_count: 0 });
  });
  afterEach(() => cleanup());

  it('keeps the credential — detach must never escalate into disconnect', async () => {
    const captured = mount(PROJECT);

    await act(async () => {
      await captured.current!.detach('github', 'github');
    });

    expect(h.detach).toHaveBeenCalledTimes(1);
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('detaches the project it was told to, not the selected one', async () => {
    // The usage popover manages placement for projects other than the current
    // one; passing the target through is what makes that possible.
    const other = { type: 'project', id: 'p2', toString: () => 'project-p2' } as never;
    const captured = mount(PROJECT);

    await act(async () => {
      await captured.current!.detach('github', 'github', other);
    });

    expect(h.detach).toHaveBeenCalledWith('github', other);
  });
});

describe('useOAuthConnection — with no project selected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userTable = { values: [HELD_GITHUB] };
  });
  afterEach(() => cleanup());

  it('reports a held credential as available rather than denying it exists', () => {
    const captured = mount(undefined);

    expect(captured.current!.connectionStatuses.github).toBe(ConnectionStatus.AVAILABLE);
    expect(captured.current!.grantStatuses.github).toBe('held');
  });

  it('still reports nothing held as disconnected', () => {
    h.userTable = { values: [{ ...HELD_GITHUB, ref_name: undefined }] };
    const captured = mount(undefined);

    expect(captured.current!.connectionStatuses.github).toBe(ConnectionStatus.DISCONNECTED);
    expect(captured.current!.grantStatuses.github).toBe('none');
  });
});
