import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, GitBranch, Loader2, MessageSquarePlus, Send, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Conversation,
  PrefKey,
  checkShareAttachments,
  type GitignoredReference,
  hasRemoteParticipant,
  hasSomethingToSend,
  mintInviteLink,
  normalizeEmail,
  oauthService,
  OAUTH_PROVIDERS,
  OAuthStatus,
  TypeId,
  type Project,
  type ConversationParticipant,
  type ConversationSendPayload,
  type UnshippableReference,
  withoutReferences,
} from '@sdk';
import { useInstancePreferences } from '@sdk/react/hooks';
import { useShareOwnerProject } from '@src/hooks/use-share-owner-project';
import { useLinkProjectToCloud } from '@src/hooks/use-link-project-to-cloud';
import { NO_PROJECT_ROLE, useShareProjectMembership } from '@src/hooks/use-share-project-membership';
import { WikiButton } from '@src/components/wiki-tip/WikiButton';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks';
import { errorMessage } from '@src/lib/error-message';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useSendToConversation, type SendTarget } from '@src/hooks/use-send-to-conversation';
import { useConversationsForContacts } from '@src/hooks/use-conversations-for-contacts';
import { useAutoTitle } from '@src/hooks/use-auto-title';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { guardCloudAction } from '@src/services/privacy-guard';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { SendProgressNotice } from '@src/components/conversation/SendProgressNotice';
import type { ShareSource, SharePrepPayload } from '@src/hooks/share-sources';
import { type CarriedEntity, DownloadMessageDialog } from '@src/components/share-to-conversation/DownloadMessageForm';
import { GitignoredNotice } from '@src/components/share-to-conversation/GitignoredNotice';
import { runGitShareFix, useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { WikiTip } from '@src/components/wiki-tip/WikiTip';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import { FileAttachmentPicker, useFileStateAttach } from '@src/components/conversation/FileAttachmentPicker';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { CopyButton } from '@src/components/ui/copy-button';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';

interface ShareToConversationDialogProps {
  open: boolean;
  onClose: () => void;
  /** What is being shared. Performs its own prep (entity refs / Task / Spec
   *  mint) on submit; never creates a conversation. */
  source: ShareSource;
  /** Scope existing-conversation results to a single project. Defaults to the active project. */
  projectId?: string | null;
  /** Pre-fill the "Note" textarea (e.g. a feed entry's suggested message text).
   *  Read once when the dialog opens; the user can edit or clear it. */
  defaultNote?: string;
  /** Seed the contact picker so an existing conversation is pre-selected
   *  (e.g. the feed's suggested support conversation). Read once on open. */
  initialParticipants?: ConversationParticipant[];
  /** Fires with the conversation id once a share succeeds (before the user
   *  closes the success screen) — lets callers dismiss the source surface. */
  onShared?: (conversationId: string) => void;
  /** Replace the default send (sendReply / createAndSendConversation) with a
   *  custom commit — e.g. message forward, which POSTs the forward action
   *  instead of add_message. Receives the chosen target + the prepared
   *  payload; must return the conversation id (or null on failure). The
   *  dialog still owns prep, busy/error state, and the success screen. */
  commit?: (target: SendTarget, payload: ConversationSendPayload) => Promise<string | null>;
  /** Hide the Title input — the source already supplies a `defaultTitle` and
   *  the user has no reason to edit it (e.g. forwarding a diagnosis). The
   *  effective title still derives from the source default. */
  hideTitle?: boolean;
  /** Hide the Note textarea — the attached entity carries the meaning, so a
   *  personal note is noise (e.g. forwarding a diagnosis). A `defaultNote`, if
   *  given, is still sent as the message caption. */
  hideNote?: boolean;
  /** Override the Title input placeholder (e.g. collaboration framing instead
   *  of the default "What do you need help with?"). */
  titlePlaceholder?: string;
  /** Override the submit button label (e.g. "Send invite" for Collaborate).
   *  Defaults to "Share". */
  submitLabel?: string;
  /** Override the dialog heading (e.g. "Collaborate on this session").
   *  Defaults to "Share". */
  heading?: string;
  /** Keep the local `project_id` on a NEW conversation even when the recipient
   *  is remote. By default remote shares from arbitrary surfaces drop the
   *  active-project association (it'd be arbitrary); Collaborate opts in so the
   *  new conversation stays scoped to the workspace that started it (the hub
   *  body still strips project_id — this only affects the sender's local row). */
  associateProjectOnRemote?: boolean;
}

const MAX_CONVERSATIONS = 5;

/** Sentinel for the "start a new conversation" row (never a real UUID). */
const NEW_CONVERSATION = '__new__';

/** Who the last share went to — prefilled the next time the dialog opens
 *  without recipients. A per-viewer convenience: absent storage just means
 *  an empty "To". */
const LAST_PARTICIPANTS_KEY = 'flowpad.share.lastParticipants';

function readLastParticipants(): ConversationParticipant[] {
  try {
    const raw = window.localStorage.getItem(LAST_PARTICIPANTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as ConversationParticipant[]) : [];
  } catch {
    return [];
  }
}

function rememberLastParticipants(participants: ConversationParticipant[]): void {
  try {
    window.localStorage.setItem(LAST_PARTICIPANTS_KEY, JSON.stringify(participants));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

/** Shared styling for a selectable conversation row; `dashed` marks the "new" row. */
const rowClasses = (isSelected: boolean, dashed = false) =>
  cn(
    'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-start text-xs text-foreground disabled:pointer-events-none disabled:opacity-50',
    dashed && 'border-dashed',
    isSelected ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-input bg-background hover:bg-muted/50',
  );

/**
 * The single contact-first share screen. Pick recipients (typeahead +
 * address-book multi-select) → see the conversations you already have with all
 * of them → click one to share into it, or start a new one. First contact = one
 * conversation + one invite; later shares thread into the existing conversation
 * with no new invite (the duplicate-conversation/email fix).
 */
/**
 * The backend's machine code for a refused share.
 *
 * Graph actions put theirs at `data.data.code` (`ProjectPublishBlocked.data()`),
 * NOT at `data.error_code` where `describeApiError` looks. Only one code is
 * branched on — everything else is shown in the backend's own words.
 */
function shareFailureCode(error: unknown): string {
  const e = error as { response?: { data?: { data?: { code?: unknown } } } } | null;
  const code = e?.response?.data?.data?.code;
  return typeof code === 'string' ? code : '';
}

export function ShareToConversationDialog({
  open,
  onClose,
  source,
  projectId,
  defaultNote,
  initialParticipants,
  onShared,
  commit,
  hideTitle,
  hideNote,
  titlePlaceholder,
  submitLabel,
  heading,
  associateProjectOnRemote,
}: ShareToConversationDialogProps) {
  const { t } = useLingui();
  // A thing share (the source says so): always a new conversation titled
  // "<Name> has shared <thing>", copy vs git decided by project membership, and
  // a link at the end. A custom commit (a forward) keeps its own behavior.
  const thingShare = !!source.shareAsThing && !commit;
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { cloudUser } = useAuth();
  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();
  const { send, busy: sendBusy, error, resetDraft } = useSendToConversation();
  // Busy state for custom commits — useSendToConversation only tracks its own.
  const [commitBusy, setCommitBusy] = useState(false);
  // What a download carries: exactly what Share would send (`source.prepare`), minus the recipients.
  const [downloadRefs, setDownloadRefs] = useState<CarriedEntity[] | null>(null);
  const { linkProject, linking } = useLinkProjectToCloud();
  const busy = sendBusy || commitBusy || linking;
  const { preferences } = useInstancePreferences();
  const owner = useShareOwnerProject(source.ownerRef, open);
  const [linkedProject, setLinkedProject] = useState<Project | null>(null);
  const owningProject = linkedProject ?? owner.project;
  const [step, setStep] = useState<'loading' | 'link' | 'compose'>('loading');
  const [dontAsk, setDontAsk] = useState(false);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const [excludedRefs, setExcludedRefs] = useState<Set<string>>(new Set());
  const [skipMembership, setSkipMembership] = useState(false);
  const [roleChoices, setRoleChoices] = useState<Record<string, string>>({});
  const shareInFlight = useRef(false);
  const openGeneration = useRef(0);
  useEffect(
    () => () => {
      openGeneration.current += 1;
    },
    [open],
  );
  const openRef = useRef(open);
  openRef.current = open;
  const sourceRemoved =
    !!source.previewAssets?.length && source.previewAssets.every((a) => excludedRefs.has(a.ref.toString()));

  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const membershipRecipients = useMemo(
    () => participants.map((p) => p.email || p.user_id || '').filter(Boolean),
    [participants],
  );
  const membership = useShareProjectMembership(
    owningProject,
    membershipRecipients,
    open && owningProject?.remote === true && !source.accessGrantRef && !sourceRemoved,
  );
  const roleProjectRef = useRef(owningProject?.id);
  useEffect(() => {
    const projectChanged = roleProjectRef.current !== owningProject?.id;
    roleProjectRef.current = owningProject?.id;
    setRoleChoices((current) =>
      projectChanged
        ? {}
        : Object.fromEntries(Object.entries(current).filter(([recipient]) => membershipRecipients.includes(recipient))),
    );
    setSkipMembership(false);
  }, [membershipRecipients, owningProject?.id]);
  const selectedRoles = Object.fromEntries(
    membership.nonMembers.map((r) => [
      r,
      roleChoices[r] ?? (!thingShare && membership.roles.includes('guest') ? 'guest' : NO_PROJECT_ROLE),
    ]),
  );
  const [titleInput, setTitleInput] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const { handlePaste } = useFileStateAttach(setFiles, {
    enabled: !busy && !!source.supportsFiles,
    setText: setNote,
  });
  const [attachTranscript, setAttachTranscript] = useState(true);
  // "Create bookmark" opt-in (default off): the receiver mints a favorite
  // pointing at the shared asset when it installs. Only offered for bookmarkable
  // sources (assets/artifacts).
  const [createBookmark, setCreateBookmark] = useState(false);
  // Conversation-scoped "Git sharing" opt-in: when on (and the asset is
  // eligible), the share rides the asset's Git origin instead of copied bytes.
  // Initialized from the selected conversation (new → off) and committed on
  // submit so later replies inherit it. Only meaningful for git-capable sources.
  const [gitSharing, setGitSharing] = useState(false);
  // Which conversation row is selected (a conversation id, or NEW_CONVERSATION).
  // Click selects; double-click or the Share button commits.
  const [selected, setSelected] = useState<string>(NEW_CONVERSATION);
  const [sharedConversationId, setSharedConversationId] = useState<string | null>(null);
  // The invite link to the new conversation, shown once on the success screen.
  // The hub keeps only a hash of it, so it can't be shown again later.
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareLinkError, setShareLinkError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // Attachments that would arrive EMPTY (a session whose transcript is gone). Found before anything is
  // created or anyone is invited; the notice offers to send without them. `canSendWithout` is false when
  // nothing else would be sent, so the offer is not made for a message with nothing in it.
  const [unshippable, setUnshippable] = useState<{
    existingId: string | null;
    gaps: UnshippableReference[];
    canSendWithout: boolean;
  } | null>(null);
  // Attachments whose copy would carry files git excludes (often private). Shown before anything is
  // created; "Send anyway" sends them.
  const [gitignored, setGitignored] = useState<{ existingId: string | null; items: GitignoredReference[] } | null>(
    null,
  );
  // A non-null id is the single source of truth for "share succeeded".
  const shared = sharedConversationId !== null;

  const effectiveProjectId = projectId ?? ctx.project?.id ?? null;
  const matches = useConversationsForContacts(participants, effectiveProjectId, open);
  const conversations = useMemo(() => matches.conversations.slice(0, MAX_CONVERSATIONS), [matches.conversations]);
  // Default selection follows the list: the latest existing conversation
  // (sorted updated_date desc by the hook), or "start new" when there are none.
  // Keyed on the latest id (not the array ref) so a background refetch that
  // returns the same list doesn't clobber the user's current selection.
  const latestConvId = conversations[0]?.id ?? null;
  useEffect(() => {
    setSelected(thingShare ? NEW_CONVERSATION : (latestConvId ?? NEW_CONVERSATION));
  }, [latestConvId, thingShare]);
  const newConvTitle = useAutoTitle(open, participants);

  // Seed values are read once at open (via refs) so a caller passing a fresh
  // array/string each render can't re-run the reset effect and clobber edits.
  const defaultNoteRef = useRef(defaultNote);
  defaultNoteRef.current = defaultNote;
  const initialParticipantsRef = useRef(initialParticipants);
  initialParticipantsRef.current = initialParticipants;

  // Single share gate: in Local (private) mode the cloud is off-limits, so the
  // share dialog never opens — all 7 share surfaces funnel through here. The
  // guard raises the one standardized "Sharing disabled in Local mode" notice.
  useEffect(() => {
    if (!open) return;
    if (!guardCloudAction('share')) {
      onClose();
    }
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    // No recipient given: share with whoever the last share went to.
    setParticipants(initialParticipantsRef.current ?? readLastParticipants());
    setTitleInput('');
    setNote(defaultNoteRef.current ?? '');
    setFiles([]);
    setNoteExpanded(!!defaultNoteRef.current?.trim());
    setExcludedRefs(new Set());
    setRoleChoices({});
    setSkipMembership(false);
    setLinkedProject(null);
    setDontAsk(false);
    setStep('loading');
    setAttachTranscript(true);
    setCreateBookmark(false);
    setGitSharing(false);
    setSharedConversationId(null);
    setShareLink(null);
    setShareLinkError(null);
    setLocalError(null);
    setUnshippable(null);
    setGitignored(null);
    resetDraft();
  }, [open, resetDraft]);

  useEffect(() => {
    if (!open || step !== 'loading' || owner.loading || !preferences.isLoaded) return;
    setStep(
      owningProject && !owningProject.remote && preferences.get(PrefKey.SHARE_CLOUD_LINK) === 'ask'
        ? 'link'
        : 'compose',
    );
  }, [open, step, owner.loading, owningProject, preferences, preferences.version]);

  const continueSharing = () => {
    if (dontAsk) preferences.set(PrefKey.SHARE_CLOUD_LINK, 'skip');
    setStep('compose');
  };
  const linkOwner = async () => {
    if (!owningProject) return;
    setLocalError(null);
    const generation = openGeneration.current;
    try {
      const canonical = await linkProject(owningProject);
      if (!openRef.current || generation !== openGeneration.current) return;
      setLinkedProject(canonical);
      continueSharing();
    } catch (err) {
      if (openRef.current && generation === openGeneration.current)
        setLocalError(errorMessage(err, t`Could not link this project.`));
    }
  };

  const isRemote = hasRemoteParticipant(participants);
  const recipientEmails = useMemo(
    () => participants.map((p) => normalizeEmail(p.email) || '').filter((e) => !!e && e.includes('@')),
    [participants],
  );
  // The title is always editable. When the user hasn't typed one, fall back to
  // the source default / auto-generated title (shown as the input's placeholder).
  // `requiresTitle` sources have no fallback — the user must type one.
  const senderName = localUser?.name || cloudUser?.name || cloudUser?.email || t`Someone`;
  const sharedThing = source.label;
  const defaultTitle = source.requiresTitle
    ? ''
    : thingShare
      ? t`${senderName} has shared ${sharedThing}`
      : (source.defaultTitle ?? newConvTitle);
  const effectiveTitle = (titleInput.trim() || defaultTitle).trim();
  const titleOk = !source.requiresTitle || titleInput.trim().length > 0;
  const canStartNew = participants.length > 0 && (isRemote || !!effectiveProjectId) && titleOk;
  const hasContacts = participants.length > 0;
  const isNewSelected = selected === NEW_CONVERSATION;

  // Git sharing: eligibility is asset-only (backend preflight); the toggle's
  // initial value follows the selected conversation's remembered default.
  const gitCapable = source.gitPreflightRef != null && !sourceRemoved;
  const preflight = useGitSharePreflight(source.gitPreflightRef, open && gitCapable);
  // A share that must also grant access (a Project). The entity is loaded in
  // full because `APIEntity.share` POSTs `this.toJSON()` — a husk instance
  // would send a husk body.
  const grantRef = sourceRemoved ? undefined : source.accessGrantRef;
  const { data: grantEntity } = useEntity<Project>(grantRef ?? null);
  const [needsGitHub, setNeedsGitHub] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const retryAfterConnect = useRef<(() => void) | null>(null);
  // Re-init the toggle ONLY when the selection changes (a ref keeps the effect
  // off the conversation list's identity, so a background refetch can't clobber
  // a manual toggle within one selection).
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  // Git is ON whenever the asset can travel by git (now, or after its one-click
  // fix) — sharing a repo file is a git pointer by default — or the
  // conversation already shares by git. The sender can still switch it off.
  // Applied when the selection changes or the preflight first answers — never
  // again after, so a sender's own "off" is not overridden by a refetch.
  const gitEligibleRef = useRef(false);
  gitEligibleRef.current = preflight.available || !!preflight.fix;
  useEffect(() => {
    if (!gitCapable || thingShare) return;
    const conv = conversationsRef.current.find((c) => c.id === selected);
    setGitSharing(gitEligibleRef.current || (conv?.git_sharing_enabled ?? false));
  }, [selected, gitCapable, preflight.answered, thingShare]);
  // A thing share picks git only when every recipient can already read the
  // project's files (a member with a real role) and the asset can travel by
  // git. Anyone else in the share means everyone gets a copy.
  const everyoneInProject =
    owningProject?.remote === true &&
    participants.length > 0 &&
    membership.status === 'ready' &&
    membership.outsiders.length === 0;
  // What this share actually does: the rule for a thing share, the sender's toggle otherwise.
  const shareByGit = thingShare ? everyoneInProject && preflight.available : gitSharing;

  // Git mode is on-and-eligible; blocked = on but not (yet) shareable. A blocked
  // toggle stops the share entirely — we never silently downgrade to a copy.
  const gitMode = gitCapable && shareByGit && preflight.available;
  const gitBlocked = gitCapable && shareByGit && (preflight.loading || !preflight.available);
  // The one-click fix for a blocked Git share: commit + push only this asset, or
  // push what is already committed. A conflict is reported, never forced.
  const [fixBusy, setFixBusy] = useState(false);
  const applyGitFix = useCallback(async () => {
    const ref = source.gitPreflightRef;
    if (!ref || !preflight.fix) return;
    setFixBusy(true);
    try {
      const res = await runGitShareFix(ref, preflight.fix);
      if (!res.ok) {
        setLocalError(
          res.kind === 'conflict'
            ? t`Someone else changed this file on the remote. Resolve the conflict in Git, then share again.`
            : res.message || t`Git could not commit or push this file.`,
        );
      }
    } catch (e) {
      setLocalError(errorMessage(e, t`Git could not commit or push this file.`));
    } finally {
      setFixBusy(false);
    }
  }, [source.gitPreflightRef, preflight.fix, t]);
  const canShareSelected =
    !(sourceRemoved && !note.trim() && !files.length) &&
    (skipMembership || (membership.status !== 'loading' && membership.status !== 'error')) &&
    !gitBlocked &&
    (isNewSelected ? canStartNew : conversations.some((c) => c.id === selected));

  // Subscribed only while THIS dialog's connect is pending, so an abandoned
  // flow leaves no listener behind.
  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (message) => {
      setConnecting(false);
      if (message.status !== OAuthStatus.SUCCESS) {
        setLocalError(t`GitHub authorization did not complete.`);
        return;
      }
      setNeedsGitHub(false);
      const retry = retryAfterConnect.current;
      retryAfterConnect.current = null;
      retry?.();
    },
    connecting,
  );

  const connectGitHub = async () => {
    if (connecting) return;
    setConnecting(true);
    setLocalError(null);
    try {
      await oauthService.connect(OAUTH_PROVIDERS.GITHUB);
    } catch (e) {
      setConnecting(false);
      setLocalError(errorMessage(e, t`GitHub authorization did not complete.`));
    }
  };

  const doShare = async (
    existingId: string | null,
    dropRefs?: ReadonlySet<string>,
    opts: { includeGitignored?: boolean } = {},
  ) => {
    if (busy || shareInFlight.current) return;
    shareInFlight.current = true;
    setCommitBusy(true);
    try {
      setLocalError(null);
      setUnshippable(null);
      setGitignored(null);
      // Fail closed: Git is on but the asset isn't (yet) eligible. Never fall back
      // to a silent copy — the sender must turn Git off to share it as a copy.
      if (gitBlocked) {
        setLocalError(preflight.reason ?? t`This asset can't be shared with Git. Turn Git sharing off to send a copy.`);
        return;
      }
      if (isRemote) {
        const gate = await ensureCloudLogin();
        if (!gate.ok) {
          setLocalError(gate.error);
          return;
        }
      }
      let payload: ConversationSendPayload;
      try {
        const prepared: SharePrepPayload = sourceRemoved
          ? { assetReferences: [], sharedContextEntities: [], files }
          : await source.prepare({
              recipientEmails,
              senderName: localUser?.name ?? null,
              senderId: localUser?.id ?? null,
              title: effectiveTitle,
              projectId: effectiveProjectId,
              attachTranscript,
              files,
            });
        // `createBookmark` can only be true when the checkbox rendered, which
        // requires `source.bookmarkable` — no need to re-check it here. Git mode
        // (on + eligible) sets the body transfer policy; it's independent of the
        // Create Bookmark opt-in.
        let mergedShareConfig = prepared.shareConfig ?? source.shareConfig;
        if (gitMode) mergedShareConfig = { ...(mergedShareConfig ?? {}), transferMode: 'git' as const };
        if (createBookmark) mergedShareConfig = { ...(mergedShareConfig ?? {}), createBookmark: true };
        if (opts.includeGitignored) mergedShareConfig = { ...(mergedShareConfig ?? {}), includeGitignored: true };
        payload = {
          text: note.trim(),
          files: prepared.files,
          assetReferences: prepared.assetReferences,
          sharedContextEntities: prepared.sharedContextEntities,
          shareConfig: mergedShareConfig,
        };
        payload = withoutReferences(payload, excludedRefs);
        if (sourceRemoved && !hasSomethingToSend(payload)) {
          setLocalError(t`There is nothing left to send — add a message first.`);
          return;
        }
        if (dropRefs) {
          // "Send without it": the references that would arrive empty come off the message AND off the
          // shared context, so the conversation is never left pointing at something that was not sent.
          payload = withoutReferences(payload, dropRefs);
          if (!hasSomethingToSend(payload)) {
            setLocalError(t`There is nothing left to send — add a message first.`);
            return;
          }
        } else {
          // Ask BEFORE anything is created: sharing into a new conversation creates it and invites the
          // recipient first, so a refusal after that would leave them holding an empty conversation.
          // Fail open — if the check itself cannot run, the send's own refusal is still the backstop.
          let gaps: UnshippableReference[] = [];
          let excluded: GitignoredReference[] = [];
          try {
            const check = await checkShareAttachments(payload.assetReferences ?? [], {
              transferMode: gitMode ? 'git' : 'copy',
            });
            gaps = check.unshippable;
            excluded = check.gitignored;
          } catch (checkErr) {
            console.warn('[share] could not check the attachments', checkErr);
          }
          if (gaps.length > 0) {
            const without = withoutReferences(payload, new Set(gaps.map((g) => g.type_id)));
            setUnshippable({ existingId, gaps, canSendWithout: hasSomethingToSend(without) });
            return;
          }
          if (excluded.length > 0 && !opts.includeGitignored) {
            setGitignored({ existingId, items: excluded });
            return;
          }
        }
        // Grant BEFORE sending. The message is only the channel: without a role on
        // the project the hub never pushes the row, and the recipient gets a note
        // about files they cannot install. Failing here aborts the send rather than
        // promising something that will not arrive.
        if (grantRef) {
          if (!grantEntity) {
            setLocalError(t`Still loading this project — try again in a moment.`);
            return;
          }
          if (!recipientEmails.length) {
            setLocalError(t`Add someone with an email address to share this project with.`);
            return;
          }
          try {
            await grantEntity.share(recipientEmails);
            setNeedsGitHub(false);
          } catch (e) {
            // The one refusal with a one-click fix; everything else the backend
            // explains better than a guess here.
            if (shareFailureCode(e) === 'github_not_connected') {
              retryAfterConnect.current = () => void doShare(existingId);
              setNeedsGitHub(true);
              return;
            }
            setLocalError(errorMessage(e, t`This project could not be shared.`));
            return;
          }
        }
        if (!skipMembership && (membership.status === 'error' || membership.status === 'loading')) {
          setLocalError(membership.error ?? t`Checking project membership…`);
          return;
        }
        if (!skipMembership) await membership.invite(selectedRoles);
        const target: SendTarget = existingId
          ? { kind: 'existing', conversationId: existingId }
          : {
              kind: 'new',
              params: {
                project_id: isRemote && !associateProjectOnRemote ? null : effectiveProjectId,
                participants,
                title: effectiveTitle,
                shared_context_entities: payload.sharedContextEntities,
              },
            };
        let convId: string | null;
        if (commit) {
          convId = await commit(target, payload);
        } else {
          convId = await send(target, payload);
        }
        if (convId) {
          // Remember the Git-sharing choice on the conversation so later replies
          // (from either side) inherit it. Best-effort — the share already
          // succeeded; a failed preference write must not surface as a share error.
          if (gitCapable) {
            const conv = conversations.find((c) => c.id === convId) ?? new Conversation({ id: convId });
            if ((conv.git_sharing_enabled ?? false) !== shareByGit) {
              try {
                await conv.setGitSharingEnabled(shareByGit);
              } catch (prefErr) {
                console.warn('[share] failed to persist git_sharing_enabled', prefErr);
              }
            }
          }
          if (participants.length) rememberLastParticipants(participants);
          setSharedConversationId(convId);
          onShared?.(convId);
          if (thingShare && isRemote) {
            try {
              const link = await mintInviteLink(new TypeId('conversation', convId));
              setShareLink(link.url);
            } catch (linkErr) {
              setShareLinkError(errorMessage(linkErr, t`The share was sent, but a link could not be created.`));
            }
          }
        }
      } catch (err: unknown) {
        setLocalError(err instanceof Error ? err.message : 'Failed to share');
      }
    } finally {
      shareInFlight.current = false;
      setCommitBusy(false);
    }
  };

  // Download = this share as a file: the same prep Share runs, so every kind of share (a session's
  // transcript, an asset, an artifact) carries what it would have sent. Files picked here cannot ride
  // an export yet — only entities.
  const openDownload = async () => {
    setLocalError(null);
    try {
      const prepared: SharePrepPayload = sourceRemoved
        ? { assetReferences: [], sharedContextEntities: [] }
        : await source.prepare({
            recipientEmails: [],
            senderName: localUser?.name ?? null,
            senderId: localUser?.id ?? null,
            title: effectiveTitle,
            projectId: effectiveProjectId,
            attachTranscript,
            files,
          });
      const refs = [...new Set(prepared.assetReferences)].filter((ref) => !excludedRefs.has(ref));
      setDownloadRefs(refs.map((typeid, i) => ({ typeid, label: i === 0 ? source.label : typeid })));
    } catch (e) {
      setLocalError(errorMessage(e, t`This could not be prepared for download.`));
    }
  };

  const shownError = localError ?? error;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="share-to-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary rtl:-scale-x-100" />
            {heading ?? <Trans>Share</Trans>}
            {!shared && step === 'compose' && owningProject && !owningProject.remote && (
              <span className="me-6 ms-auto text-xs font-normal text-amber-600">
                <Trans>Untracked sharing</Trans>{' '}
                <button type="button" className="underline" disabled={busy} onClick={() => void linkOwner()}>
                  link&amp;track
                </button>
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        {downloadRefs && <DownloadMessageDialog open onClose={() => setDownloadRefs(null)} initial={downloadRefs} />}

        {!shared && step === 'loading' ? (
          <div className="flex justify-center p-6">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !shared && step === 'link' ? (
          <div className="flex flex-col gap-5 text-sm" data-testid="share-cloud-link-step">
            <h2 className="text-lg font-semibold">
              <Trans>Track your shared assets</Trans>
            </h2>
            <div>
              <p>
                <Trans>Link project to cloud to securely and privately manage your shared assets.</Trans>
              </p>
              <WikiButton wikiword="Cloud sharing" linkText={t`Learn more`} className="mt-2" />
            </div>
            <div className="rounded-md border p-3">
              <span className="font-medium">{owningProject?.displayName}</span>
              <p className="text-xs text-muted-foreground">
                <Trans>Not linked to cloud</Trans>
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} disabled={busy} />
              <Trans>Don’t ask again</Trans>
            </label>
            {shownError && <p className="text-xs text-destructive">{shownError}</p>}
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => void linkOwner()}
              disabled={busy}
              data-testid="share-link-project"
            >
              {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Link</Trans>}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              disabled={busy}
              onClick={continueSharing}
              data-testid="share-skip-link"
            >
              <Trans>Skip</Trans>
            </button>
          </div>
        ) : shared ? (
          <div className="flex flex-col items-center gap-4 py-6 text-sm" data-testid="share-status">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
              <Check className="h-6 w-6" />
            </div>
            <p className="font-medium text-foreground">
              <Trans>Shared</Trans>
            </p>
            {shareLink && (
              <div className="flex w-full flex-col gap-1.5" data-testid="share-link">
                <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Link</Trans>
                </label>
                <div className="flex gap-2">
                  <Input readOnly value={shareLink} onFocus={(e) => e.target.select()} data-testid="share-link-url" />
                  <CopyButton
                    value={shareLink}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm"
                    iconClassName="h-4 w-4"
                    label={t`Copy`}
                    copiedLabel={t`Copied`}
                    testId="share-link-copy"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  <Trans>Send this link to anyone you want to give access. It is shown only once.</Trans>
                </p>
              </div>
            )}
            {shareLinkError && <p className="text-xs text-destructive">{shareLinkError}</p>}
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                <Trans>Close</Trans>
              </Button>
              <Button
                onClick={() => {
                  if (sharedConversationId) {
                    navigation.openDock(DockPointer.forConversation(sharedConversationId));
                  }
                  onClose();
                }}
                disabled={!sharedConversationId}
                data-testid="share-open-message"
              >
                <Trans>Open message</Trans>
              </Button>
            </div>
          </div>
        ) : (
          // min-w-0: DialogContent is a grid; without it this item's min-width:auto
          // lets a long nowrap row title (the `truncate` spans) inflate the column
          // track past max-w-md, spilling every row outside the dialog.
          <div className="flex min-w-0 flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                <Trans>To</Trans>
              </label>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <ContactPicker
                    value={participants}
                    onChange={setParticipants}
                    excludeUserId={cloudUser?.id ?? ctx.user?.id}
                    enabled={open}
                    testId="share-contact-picker"
                  />
                </div>
                <AddressBookButton
                  value={participants}
                  onChange={setParticipants}
                  excludeUserId={cloudUser?.id ?? ctx.user?.id}
                  enabled={open}
                  disabled={busy}
                />
              </div>
            </div>

            {!hideTitle && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Title</Trans>
                </label>
                <Input
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  placeholder={
                    titlePlaceholder ??
                    (source.requiresTitle ? t`What do you need help with?` : defaultTitle || t`Conversation title`)
                  }
                  disabled={busy}
                  data-testid="share-title-input"
                />
              </div>
            )}

            {!hideNote && !noteExpanded && (
              <button
                type="button"
                className="self-start text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setNoteExpanded(true)}
                data-testid="share-add-note"
              >
                <Trans>Add note</Trans>
              </button>
            )}
            {!hideNote && noteExpanded && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Note (optional)</Trans>
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onPaste={handlePaste}
                  placeholder={t`Add a personal note…`}
                  rows={2}
                  disabled={busy}
                  className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="share-note-input"
                />
              </div>
            )}

            <div className="flex flex-wrap gap-2" data-testid="share-asset-chips">
              {source.previewAssets ? (
                source.previewAssets
                  .filter((a) => !excludedRefs.has(a.ref.toString()))
                  .map((asset) => (
                    <span
                      key={asset.ref.toString()}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                    >
                      <span className="truncate">{asset.label}</span>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={t`Remove ${asset.label}`}
                        onClick={() => setExcludedRefs((current) => new Set([...current, asset.ref.toString()]))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))
              ) : (
                <span className="truncate rounded-md border bg-muted/40 px-2 py-1 text-xs">{source.label}</span>
              )}
            </div>
            {membership.status === 'loading' && (
              <p className="text-xs text-muted-foreground">
                <Trans>Checking project membership…</Trans>
              </p>
            )}
            {membership.status === 'error' && (
              <div className="text-xs text-destructive">
                {membership.error}{' '}
                <button type="button" onClick={() => void membership.refresh()} className="underline">
                  <Trans>Retry</Trans>
                </button>
                <label className="mt-2 flex items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={skipMembership}
                    onChange={(event) => setSkipMembership(event.target.checked)}
                  />
                  <Trans>Share without project membership</Trans>
                </label>
              </div>
            )}
            {membership.status === 'ready' &&
              membership.nonMembers.map((recipient) => (
                <div key={recipient} className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-xs" htmlFor={`role-${recipient}`}>
                    <Trans>Project role</Trans>
                    <WikiButton wikiword="Project roles" />
                    {membership.nonMembers.length > 1 && (
                      <span className="truncate text-muted-foreground">{recipient}</span>
                    )}
                  </label>
                  <select
                    id={`role-${recipient}`}
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    disabled={busy}
                    value={selectedRoles[recipient]}
                    onChange={(e) => setRoleChoices((current) => ({ ...current, [recipient]: e.target.value }))}
                    data-testid="share-project-role"
                  >
                    <option value={NO_PROJECT_ROLE}>{t`None`}</option>
                    {membership.roles.map((role) => (
                      <option key={role} value={role}>
                        {role.charAt(0).toUpperCase() + role.slice(1)}
                      </option>
                    ))}
                  </select>
                  {selectedRoles[recipient] === 'guest' && (
                    <p className="text-xs text-muted-foreground">
                      <Trans>Guest does not grant access to the project.</Trans>
                    </p>
                  )}
                </div>
              ))}
            {thingShare && gitCapable && participants.length > 0 && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="share-transfer-mode"
                data-mode={shareByGit ? 'git' : 'copy'}
              >
                {shareByGit ? (
                  <Trans>Recipients are project members — they get a live link to the file in git.</Trans>
                ) : (
                  <Trans>Recipients get a copy.</Trans>
                )}
              </p>
            )}
            <details className="text-xs" data-testid="share-options">
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Sharing options</Trans>
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {!shared && step === 'compose' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="me-6 ms-auto h-7 gap-1.5 text-xs"
                    onClick={() => void openDownload()}
                    disabled={busy || sourceRemoved}
                    data-testid="share-download"
                    title={t`Download as a file instead of sending`}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <Trans>Download</Trans>
                  </Button>
                )}
                {source.supportsFiles && (
                  <div className="flex flex-col gap-1.5">
                    {source.isProcess && (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={attachTranscript}
                          onChange={(e) => setAttachTranscript(e.target.checked)}
                          disabled={busy}
                        />
                        <Trans>Attach session transcript</Trans>
                      </label>
                    )}
                    <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
                  </div>
                )}

                {source.bookmarkable && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={createBookmark}
                      onChange={(e) => setCreateBookmark(e.target.checked)}
                      disabled={busy}
                      data-testid="share-create-bookmark"
                    />
                    <Trans>Create bookmark on the recipient's desktop</Trans>
                  </label>
                )}

                {gitCapable && !thingShare && (
                  <div className="flex flex-col gap-1.5">
                    <WikiTip wikiword="Git sharing" buttonLabel={t`What is Git sharing?`}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={gitSharing}
                        aria-label={t`Share using Git origin`}
                        onClick={() => {
                          // Can turn OFF anytime; can turn ON when eligible, or when a
                          // one-click fix (commit / push) can make it eligible — turning
                          // it on is what shows that fix.
                          if (!gitSharing && !preflight.available && !preflight.fix) return;
                          setGitSharing((v) => !v);
                        }}
                        disabled={busy || preflight.loading || (!preflight.available && !preflight.fix && !gitSharing)}
                        data-testid="share-git-toggle"
                        data-state={gitSharing ? 'on' : 'off'}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          gitSharing
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-input bg-background text-muted-foreground hover:bg-muted/50',
                        )}
                      >
                        <GitBranch className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 text-start">
                          <Trans>Share using Git origin</Trans>
                        </span>
                        <span
                          aria-hidden
                          className={cn(
                            'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
                            gitSharing ? 'justify-end bg-primary' : 'justify-start bg-muted-foreground/30',
                          )}
                        >
                          <span className="h-3 w-3 rounded-full bg-background" />
                        </span>
                      </button>
                    </WikiTip>
                    {needsGitHub && (
                      <div
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                        data-testid="share-connect-github"
                      >
                        <span className="text-muted-foreground">
                          <Trans>Connect GitHub to share a project whose files live in a GitHub repository.</Trans>
                        </span>
                        <Button size="sm" onClick={() => void connectGitHub()} disabled={connecting}>
                          {connecting ? <Trans>Connecting…</Trans> : <Trans>Connect GitHub</Trans>}
                        </Button>
                      </div>
                    )}
                    {gitBlocked && (
                      <div
                        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                        data-testid="share-git-blocked"
                      >
                        {preflight.loading ? (
                          <Trans>Checking Git eligibility…</Trans>
                        ) : (
                          (preflight.reason ?? (
                            <Trans>This asset can't be shared with Git. Turn Git sharing off to send a copy.</Trans>
                          ))
                        )}
                        {!preflight.loading && preflight.fix && source.gitPreflightRef && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-2"
                            data-testid={`share-git-fix-${preflight.fix}`}
                            disabled={fixBusy}
                            onClick={() => void applyGitFix()}
                          >
                            {fixBusy ? (
                              <Trans>Working…</Trans>
                            ) : preflight.fix === 'commit' ? (
                              <Trans>Commit and push this file</Trans>
                            ) : (
                              <Trans>Push and share</Trans>
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </details>
            <details className="text-xs" data-testid="share-recent-conversations">
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Recent conversations</Trans>
              </summary>
              <div className="mt-2 flex flex-col gap-1.5">
                {!hasContacts ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>Pick a contact to see your conversations with them.</Trans>
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1" data-testid="share-conversation-list">
                    {conversations.map((conv) => {
                      const isSelected = selected === conv.id;
                      return (
                        <li key={conv.id}>
                          {/* Click selects; double-click commits the share. */}
                          <button
                            type="button"
                            onClick={() => setSelected(conv.id)}
                            onDoubleClick={() => void doShare(conv.id)}
                            disabled={busy}
                            aria-pressed={isSelected}
                            data-selected={isSelected}
                            className={rowClasses(isSelected)}
                            data-testid={`share-conv-row-${conv.id}`}
                          >
                            <span className="flex-1 truncate text-foreground">{deriveConversationTitle(conv)}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {formatTimeAgo(conv.updated_date ? new Date(conv.updated_date).toISOString() : null) ??
                                ''}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {/* "Start new" is always last, set apart by a divider + gap. */}
                    <li className={cn(conversations.length > 0 && 'mt-2 border-t border-border/60 pt-2')}>
                      <button
                        type="button"
                        onClick={() => setSelected(NEW_CONVERSATION)}
                        onDoubleClick={() => void doShare(null)}
                        disabled={busy}
                        aria-pressed={isNewSelected}
                        data-selected={isNewSelected}
                        className={rowClasses(isNewSelected, true)}
                        data-testid="share-conv-row-new"
                      >
                        <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="flex-1 truncate" title={effectiveTitle}>
                          <Trans>Start new conversation · {effectiveTitle}</Trans>
                        </span>
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            </details>
            {unshippable && (
              <div
                className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                data-testid="share-unshippable"
              >
                <p className="font-medium">
                  <Trans>Nothing would arrive for this, so it was not sent:</Trans>
                </p>
                <ul className="list-disc ps-4">
                  {unshippable.gaps.map((gap) => (
                    <li key={gap.type_id} className="break-all">
                      <span className="font-mono">{gap.type_id}</span> — {gap.reason}
                    </li>
                  ))}
                </ul>
                <p>
                  <Trans>
                    The file may have been removed, or it was never created — a session with no conversation yet has no
                    transcript.
                  </Trans>
                </p>
                <div className="flex flex-wrap gap-2">
                  {unshippable.canSendWithout ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        void doShare(unshippable.existingId, new Set(unshippable.gaps.map((g) => g.type_id)))
                      }
                      disabled={busy}
                      data-testid="share-send-without"
                    >
                      {source.isProcess ? <Trans>Send without the session</Trans> : <Trans>Send without it</Trans>}
                    </Button>
                  ) : (
                    <span>
                      <Trans>Add a message to send without it.</Trans>
                    </span>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setUnshippable(null)} disabled={busy}>
                    <Trans>Dismiss</Trans>
                  </Button>
                </div>
              </div>
            )}
            {gitignored && (
              <GitignoredNotice
                items={gitignored.items}
                busy={busy}
                confirmLabel={<Trans>Send anyway</Trans>}
                onConfirm={() => void doShare(gitignored.existingId, undefined, { includeGitignored: true })}
                onCancel={() => setGitignored(null)}
              />
            )}
            {shownError && <p className="text-xs text-destructive">{shownError}</p>}

            <div className="flex items-center gap-2 pt-1">
              {/* The share path is the slow one: `source.prepare` packs the asset and
                  the backend may summarize an attached session transcript before the
                  message is even pushed. Always treat it as attachment-bearing. */}
              <SendProgressNotice busy={busy} hasAttachments />
              <div className="ms-auto flex gap-2">
                <Button variant="outline" onClick={onClose} disabled={busy}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  onClick={() => void doShare(isNewSelected ? null : selected)}
                  disabled={busy || !canShareSelected}
                  data-testid="share-submit"
                  className="gap-1.5"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 rtl:-scale-x-100" />}
                  {busy ? t`Sharing…` : (submitLabel ?? t`Share`)}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
