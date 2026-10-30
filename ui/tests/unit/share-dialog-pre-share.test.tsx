import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { credentialsService, dataManager, TypeId, Project } from '@sdk';
import type { ShareSource } from '@src/hooks/share-sources';
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
  sender: { send: vi.fn(), busy: false, error: null, resetDraft: () => undefined },
  matches: { conversations: [] as never[] },
  preflight: {
    available: false,
    loading: false,
    reason: null as string | null,
    answered: true,
    fix: null as 'commit' | 'push' | null,
    refetch: () => undefined,
  },
  gitFix: vi.fn(),
  entity: { data: null },
  owner: { project: null as Project | null, loading: false },
  preferences: { isLoaded: true, version: 0, get: vi.fn(() => 'ask'), set: vi.fn() },
  link: vi.fn(),
  membership: {
    status: 'idle',
    error: null as string | null,
    nonMembers: [] as string[],
    outsiders: [] as string[],
    roles: [] as string[],
    refresh: vi.fn(),
    invite: vi.fn(),
  },
}));
vi.mock('@src/components/contact-picker/ContactPicker', () => ({
  ContactPicker: ({
    value,
    onChange,
  }: {
    value: { email: string }[];
    onChange: (value: { email: string }[]) => void;
  }) => (
    <input
      data-testid="test-recipients"
      value={value.map((p) => p.email).join(',')}
      onChange={(event) => onChange(event.target.value.split(',').map((email) => ({ email })))}
    />
  ),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => stable.nav }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => stable.ctx }));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useInstancePreferences: () => ({ preferences: stable.preferences }),
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
  runGitShareFix: (...args: unknown[]) => stable.gitFix(...args),
}));
vi.mock('@src/hooks/entity-hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntity: () => stable.entity,
}));
vi.mock('@src/services/privacy-guard', () => ({ guardCloudAction: () => true }));
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (files: File[]) => Promise.resolve({ files, caption: '' }),
}));
vi.mock('@src/components/conversation/SendProgressNotice', () => ({ SendProgressNotice: () => null }));

const pre = vi.hoisted(() => ({ answer: { needed: false } as Record<string, unknown>, recheck: vi.fn() }));
vi.mock('@src/hooks/use-pre-share', () => ({
  usePreShare: () => ({ answered: true, answer: pre.answer, recheck: pre.recheck }),
}));
vi.mock('@src/components/wiki-tip/WikiButton', () => ({ WikiButton: () => null }));

vi.mock('@src/hooks/use-share-owner-project', () => ({ useShareOwnerProject: () => stable.owner }));
vi.mock('@src/hooks/use-link-project-to-cloud', () => ({
  useLinkProjectToCloud: () => ({ linking: false, linkProject: stable.link }),
}));
vi.mock('@src/hooks/use-share-project-membership', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShareProjectMembership: () => stable.membership,
}));
const REF = new TypeId('credential', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002');
const PID = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const prepare = vi.fn(() => Promise.resolve({ assetReferences: [REF.toString()], sharedContextEntities: [REF.toString()] }));
const source: ShareSource = {
  label: 'Bright Data', ownerRef: REF, previewAssets: [{ ref: REF, label: 'Bright Data' }], preShareRef: REF, prepare,
};
function show() {
  return render(
    <ShareToConversationDialog
      open
      onClose={() => undefined}
      source={source}
      initialParticipants={[{ email: 'ami@example.com' }]}
      commit={() => Promise.resolve('conversation-1')}
    />,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  stable.preferences.get.mockReturnValue('skip');
  pre.answer = { needed: false };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the generic pre-share step', () => {
  it('opens the standard dialog directly when the type needs nothing', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [], gitignored: [] });
    show();
    await waitFor(() => expect(screen.queryByTestId('share-preshare-step')).toBeNull());
    expect(screen.getByTestId('test-recipients')).toBeTruthy();
  });

  it("shows the type's step first, then the vault picker, then the standard dialog", async () => {
    pre.answer = {
      needed: true, kind: 'secret_vault', project_id: PID, name: 'bright_data', vaults: [],
      title: 'Share Bright Data', detail: 'Sharing credentials requires a secret manager on the project.',
    };
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [], gitignored: [] } as never);
    vi.spyOn(credentialsService, 'listManagers').mockResolvedValue([
      { name: 'onepassword', title: '1Password', description: '', icon: '', config_fields: [{ name: 'account', label: 'Account', required: false }] },
    ] as never);
    const addVault = vi.spyOn(credentialsService, 'addVault').mockResolvedValue(undefined as never);
    const publish = vi.spyOn(credentialsService, 'publish').mockResolvedValue({ published: ['BRIGHT_DATA_API'] } as never);
    show();

    await screen.findByTestId('share-preshare-step');
    expect(screen.getByText('Sharing credentials requires a secret manager on the project.')).toBeTruthy();
    expect(screen.queryByTestId('test-recipients')).toBeNull();

    fireEvent.click(screen.getByTestId('share-preshare-setup'));
    await screen.findByTestId('secret-manager-option-onepassword');
    fireEvent.change(screen.getByTestId('secret-vault-name'), { target: { value: 'team' } });
    fireEvent.change(screen.getByTestId('secret-vault-field-account'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByTestId('secret-vault-save'));

    await screen.findByTestId('test-recipients');
    expect(addVault).toHaveBeenCalledWith(PID, 'team', { manager: 'onepassword', config: { account: 'acme' } });
    expect(publish).toHaveBeenCalledWith('bright_data', PID, 'team');
  });

  it('with a vault declared, publishes into it straight from the step', async () => {
    pre.answer = { needed: true, kind: 'secret_vault', project_id: PID, name: 'bright_data', vaults: ['team'] };
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [], gitignored: [] } as never);
    const publish = vi.spyOn(credentialsService, 'publish').mockResolvedValue({ published: [] } as never);
    show();

    fireEvent.click(await screen.findByTestId('share-preshare-vault-team'));
    await screen.findByTestId('test-recipients');
    expect(publish).toHaveBeenCalledWith('bright_data', PID, 'team');
  });
});
