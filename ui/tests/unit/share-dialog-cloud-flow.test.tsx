import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dataManager, TypeId, Project } from '@sdk';
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
  sender: { send: vi.fn(), busy: false, error: null, resetDraft: () => undefined },
  matches: { conversations: [] as never[] },
  preflight: { available: false, loading: false, reason: null as string | null, answered: true },
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
  ContactPicker: ({ value, onChange }: { value: { email: string }[]; onChange: (value: { email: string }[]) => void }) => (
    <input data-testid="test-recipients" value={value.map((p) => p.email).join(',')} onChange={(event) => onChange(event.target.value.split(',').map((email) => ({email})))} />
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

vi.mock('@src/hooks/use-share-owner-project', () => ({ useShareOwnerProject: () => stable.owner }));
vi.mock('@src/hooks/use-link-project-to-cloud', () => ({
  useLinkProjectToCloud: () => ({ linking: false, linkProject: stable.link }),
}));
vi.mock('@src/hooks/use-share-project-membership', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShareProjectMembership: () => stable.membership,
}));
const REF = new TypeId('markdown', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
const prepare = vi.fn(async () => ({ assetReferences: [REF.toString()], sharedContextEntities: [REF.toString()] }));
const source: ShareSource = { label: 'Design', ownerRef: REF, previewAssets: [{ ref: REF, label: 'Design' }], prepare };
const commit = vi.fn<(target: SendTarget, payload: ConversationSendPayload) => Promise<string | null>>(async () => 'conversation-1');
function show(extra: Partial<React.ComponentProps<typeof ShareToConversationDialog>> = {}) {
  return render(
    <ShareToConversationDialog
      open
      onClose={() => undefined}
      source={source}
      initialParticipants={[{ email: 'bob@example.com' }]}
      commit={commit}
      {...extra}
    />,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  stable.owner.project = null;
  stable.preferences.get.mockReturnValue('ask');
  stable.membership.status = 'idle';
  stable.membership.error = null;
  stable.membership.nonMembers = [];
  stable.membership.outsiders = [];
  stable.membership.roles = [];
  stable.preflight.available = false;
  stable.membership.invite.mockResolvedValue(undefined);
  vi.spyOn(dataManager, 'callAction').mockResolvedValue({ unshippable: [], gitignored: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('reveals the optional note only on click and expands prefilled notes', () => {
  const view = show();
  expect(screen.queryByTestId('share-note-input')).toBeNull();
  fireEvent.click(screen.getByTestId('share-add-note'));
  expect(screen.getByTestId('share-note-input')).toBeTruthy();
  view.unmount();
  show({ defaultNote: 'Already supplied' });
  expect((screen.getByTestId('share-note-input') as HTMLTextAreaElement).value).toBe('Already supplied');
});
it('removes both attachment and context and skips preparation when sending a note alone', async () => {
  show({ defaultNote: 'A note' });
  fireEvent.click(screen.getByLabelText('Remove Design'));
  fireEvent.click(screen.getByTestId('share-submit'));
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  expect(prepare).not.toHaveBeenCalled();
  expect(commit.mock.calls[0][1]).toMatchObject({ text: 'A note', assetReferences: [], sharedContextEntities: [] });
});
it('disables empty sends after removing the last asset', () => {
  show();
  fireEvent.click(screen.getByLabelText('Remove Design'));
  expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(true);
});
it('skips the cloud step and remembers only the reminder preference', () => {
  stable.owner.project = new Project({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
    name: 'Owner project',
    remote: false,
  });
  show();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Don’t ask again' }));
  fireEvent.click(screen.getByTestId('share-skip-link'));
  expect(stable.preferences.set).toHaveBeenCalledWith('preferences.notifications.share_cloud_link', 'skip');
  expect(stable.link).not.toHaveBeenCalled();
  expect(screen.getByTestId('share-submit')).toBeTruthy();
});
it('links the canonical owning project and advances the same dialog', async () => {
  stable.owner.project = new Project({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
    name: 'Owner project',
    remote: false,
  });
  stable.link.mockResolvedValue(new Project({ id: stable.owner.project.id, remote: true }));
  show();
  fireEvent.click(screen.getByTestId('share-link-project'));
  await screen.findByTestId('share-submit');
  expect(stable.link).toHaveBeenCalledWith(stable.owner.project);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});
it('offers Guest by default and submits an explicit None choice', async () => {
  stable.membership.status = 'ready';
  stable.membership.nonMembers = ['bob@example.com'];
  stable.membership.roles = ['guest', 'member'];
  show();
  expect((screen.getByTestId('share-project-role') as HTMLSelectElement).value).toBe('guest');
  fireEvent.change(screen.getByTestId('share-project-role'), { target: { value: 'none' } });
  fireEvent.click(screen.getByTestId('share-submit'));
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  expect(stable.membership.invite).toHaveBeenCalledWith({ 'bob@example.com': 'none' });
});
it('does not send after a project invitation fails', async () => {
  stable.membership.status = 'ready';
  stable.membership.nonMembers = ['bob@example.com'];
  stable.membership.roles = ['guest'];
  stable.membership.invite.mockRejectedValue(new Error('Invitation failed'));
  show();
  fireEvent.click(screen.getByTestId('share-submit'));
  await screen.findByText('Invitation failed');
  expect(commit).not.toHaveBeenCalled();
});

it('requires explicit no-membership consent when the roster cannot be read', async () => {
  stable.membership.status = 'error';
  stable.membership.error = 'Members unavailable';
  show();
  expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', {name: 'Share without project membership'}));
  fireEvent.click(screen.getByTestId('share-submit'));
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  expect(stable.membership.invite).not.toHaveBeenCalled();
});
it('does not carry a completed old Link attempt into a reopened draft', async () => {
  stable.owner.project = new Project({id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002', remote: false});
  let complete!: (project: Project) => void;
  stable.link.mockReturnValue(new Promise<Project>((resolve) => { complete = resolve; }));
  const view = show();
  fireEvent.click(screen.getByTestId('share-link-project'));
  view.rerender(<ShareToConversationDialog open={false} onClose={() => undefined} source={source} />);
  view.rerender(<ShareToConversationDialog open onClose={() => undefined} source={source} />);
  complete(new Project({id: stable.owner.project.id, remote: true}));
  await waitFor(() => expect(screen.getByTestId('share-cloud-link-step')).toBeTruthy());
  expect(screen.queryByTestId('share-submit')).toBeNull();
});

it('keeps an existing recipient’s None choice when another recipient is added', () => {
  stable.membership.status = 'ready';
  stable.membership.nonMembers = ['bob@example.com'];
  stable.membership.roles = ['guest', 'member'];
  show();
  fireEvent.change(screen.getByTestId('share-project-role'), {target: {value: 'none'}});
  stable.membership.nonMembers = ['bob@example.com', 'alice@example.com'];
  fireEvent.change(screen.getByTestId('test-recipients'), {target: {value: 'bob@example.com,alice@example.com'}});
  const choices = screen.getAllByTestId('share-project-role') as HTMLSelectElement[];
  expect(choices.map((choice) => choice.value)).toEqual(['none', 'guest']);
  stable.membership.nonMembers = ['alice@example.com'];
  fireEvent.change(screen.getByTestId('test-recipients'), {target: {value: 'alice@example.com'}});
  stable.membership.nonMembers = ['bob@example.com', 'alice@example.com'];
  fireEvent.change(screen.getByTestId('test-recipients'), {target: {value: 'bob@example.com,alice@example.com'}});
  expect((screen.getAllByTestId('share-project-role') as HTMLSelectElement[]).map((choice) => choice.value)).toEqual(['guest', 'guest']);
});

describe('sharing a thing', () => {
  // An asset share: a new conversation titled for it, git only when every recipient
  // is inside the project, and a link to hand out at the end.
  const thing: ShareSource = { ...source, bookmarkable: true, shareAsThing: true, gitPreflightRef: REF };
  beforeEach(() => {
    stable.owner.project = new Project({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002', name: 'P', remote: true });
    stable.membership.status = 'ready';
    stable.preflight.available = true;
  });

  it('titles the conversation for the shared thing and sends members a git link', () => {
    show({ source: thing, commit: undefined });
    expect(screen.getByTestId('share-title-input').getAttribute('placeholder')).toBe('Me has shared Design');
    expect(screen.getByTestId('share-transfer-mode').getAttribute('data-mode')).toBe('git');
    expect(screen.queryByTestId('share-git-toggle')).toBeNull();
  });

  it('sends everyone a copy when one recipient is outside the project', () => {
    stable.membership.outsiders = ['bob@example.com'];
    stable.membership.nonMembers = ['bob@example.com'];
    stable.membership.roles = ['guest'];
    show({ source: thing, commit: undefined });
    expect(screen.getByTestId('share-transfer-mode').getAttribute('data-mode')).toBe('copy');
    // Sharing a file never adds someone to the project on the side.
    expect((screen.getByTestId('share-project-role') as HTMLSelectElement).value).toBe('none');
  });

  it('shows the invite link to the new conversation once shared', async () => {
    stable.sender.send.mockResolvedValue('cccccccc-cccc-4ccc-8ccc-000000000003');
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: { subpath?: string }) =>
      info.subpath === 'link' ? { url: 'https://hub.example/invite/fpinv_x' } : { unshippable: [], gitignored: [] },
    );
    show({ source: thing, commit: undefined });
    fireEvent.click(screen.getByTestId('share-submit'));
    const url = (await screen.findByTestId('share-link-url')) as HTMLInputElement;
    expect(url.value).toBe('https://hub.example/invite/fpinv_x');
    expect(stable.sender.send.mock.calls[0][0]).toMatchObject({ kind: 'new', params: { title: 'Me has shared Design' } });
  });
});
