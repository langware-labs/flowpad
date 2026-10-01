import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dataManager } from '@sdk';
import type { ConversationSendPayload } from '@sdk';
import type { ShareSource } from '@src/hooks/share-sources';
import type { SendTarget } from '@src/hooks/use-send-to-conversation';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';

// The dialog's collaborators are app plumbing (router, auth, contact lookups), not the behaviour under
// test; the share flow itself — prepare → ask what would arrive empty → commit — runs for real, and the
// only seam is the dialog's own `commit` prop, which exists to replace the send.
// Stable references: a stub that returns a fresh object on every render re-triggers the dialog's
// effects forever. Hoisted so the vi.mock factories below can see them.
const stable = vi.hoisted(() => ({
  nav: { navigation: { openDock: () => undefined } },
  ctx: { project: null },
  auth: { cloudUser: null },
  user: { localUser: { id: 'u1', name: 'Me' } },
  gate: () => Promise.resolve({ ok: true as const }),
  sender: { send: () => undefined, busy: false, error: null, resetDraft: () => undefined },
  matches: { conversations: [] as never[] },
  preflight: { available: false, loading: false, reason: null },
  entity: { data: null },
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => stable.nav }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => stable.ctx }));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuth: () => stable.auth,
  useOAuthFlowComplete: () => undefined,
}));
vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => stable.user,
}));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({
  useCloudLoginGate: () => stable.gate,
}));
vi.mock('@src/hooks/use-send-to-conversation', () => ({
  useSendToConversation: () => stable.sender,
}));
vi.mock('@src/hooks/use-conversations-for-contacts', () => ({
  useConversationsForContacts: () => stable.matches,
}));
vi.mock('@src/hooks/use-auto-title', () => ({ useAutoTitle: () => 'Auto title' }));
vi.mock('@src/hooks/use-git-share-preflight', () => ({
  useGitSharePreflight: () => stable.preflight,
}));
vi.mock('@src/hooks/entity-hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntity: () => stable.entity,
}));
vi.mock('@src/services/privacy-guard', () => ({ guardCloudAction: () => true }));
vi.mock('@src/components/conversation/SendProgressNotice', () => ({ SendProgressNotice: () => null }));

const SESSION = 'claude_session-aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PROCESS = 'agentic_process-bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const GAP = { type_id: SESSION, reason: 'its file is not on this machine' };

const source: ShareSource = {
  label: 'Session aaaaaaaa',
  typeLabel: 'SESSION',
  prepare: () => Promise.resolve({ assetReferences: [SESSION], sharedContextEntities: [SESSION, PROCESS] }),
};

const PARTICIPANTS = [{ email: 'gadi+20@langware.ai', name: 'Gadi 20' }];

type Commit = (target: SendTarget, payload: ConversationSendPayload) => Promise<string | null>;

function renderDialog(opts: { note: string; commit: Commit }) {
  return render(
    <ShareToConversationDialog
      open
      onClose={() => undefined}
      source={source}
      defaultNote={opts.note}
      initialParticipants={PARTICIPANTS}
      commit={opts.commit}
    />,
  );
}

const share = () => fireEvent.click(screen.getByTestId('share-submit'));

describe('share dialog — an attachment that would arrive empty', () => {
  let commit: ReturnType<typeof vi.fn<Commit>>;

  beforeEach(() => {
    commit = vi.fn<Commit>(() => Promise.resolve('conv-1'));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // FLOWPAD-2153. Sharing into a NEW conversation creates it and invites the recipient before the message
  // is sent, so a refusal at send time leaves them holding an invitation to an empty conversation. The
  // dialog therefore asks first, and offers "send without it" instead of failing after the fact.
  it('asks first: nothing is committed, and the notice offers to send without the session', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [GAP] });
    renderDialog({ note: 'look at this', commit });

    share();

    expect(await screen.findByTestId('share-unshippable')).toBeTruthy();
    expect(screen.getByTestId('share-send-without').textContent).toContain('Send without the session');
    expect(commit).not.toHaveBeenCalled();
  });

  it('"Send without the session" commits the message minus the session — attachment AND shared context', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [GAP] });
    renderDialog({ note: 'look at this', commit });
    share();

    fireEvent.click(await screen.findByTestId('share-send-without'));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const [target, payload] = commit.mock.calls[0];
    expect(payload.text).toBe('look at this');
    expect(payload.assetReferences).toEqual([]);
    expect(payload.sharedContextEntities).toEqual([PROCESS]);
    // The NEW conversation is created pointing at nothing that was not sent.
    expect(target.kind).toBe('new');
    expect((target as Extract<SendTarget, { kind: 'new' }>).params.shared_context_entities).toEqual([PROCESS]);
  });

  it('does not offer to send an empty message — there would be nothing in it', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [GAP] });
    renderDialog({ note: '', commit });

    share();

    expect(await screen.findByTestId('share-unshippable')).toBeTruthy();
    expect(screen.queryByTestId('share-send-without')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('sends untouched when nothing would arrive empty', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [] });
    renderDialog({ note: 'look at this', commit });

    share();

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0][1].assetReferences).toEqual([SESSION]);
    expect(commit.mock.calls[0][1].sharedContextEntities).toEqual([SESSION, PROCESS]);
    expect(screen.queryByTestId('share-unshippable')).toBeNull();
  });

  it('fails open: if the check itself cannot run the share goes ahead (the send still refuses on its own)', async () => {
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(new Error('backend unreachable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderDialog({ note: 'look at this', commit });

    share();

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0][1].assetReferences).toEqual([SESSION]);
  });
});
