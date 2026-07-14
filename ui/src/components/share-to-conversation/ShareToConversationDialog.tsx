import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, MessageSquarePlus, Send } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  hasRemoteParticipant,
  normalizeEmail,
  type ConversationParticipant,
  type ConversationSendPayload,
} from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useSendToConversation, type SendTarget } from '@src/hooks/use-send-to-conversation';
import { useConversationsForContacts } from '@src/hooks/use-conversations-for-contacts';
import { useAutoTitle } from '@src/hooks/use-auto-title';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { guardCloudAction } from '@src/services/privacy-guard';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import type { ShareSource } from '@src/hooks/share-sources';
import { useGitShareGate } from '@src/hooks/use-git-share-gate';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
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

/** Shared styling for a selectable conversation row; `dashed` marks the "new" row. */
const rowClasses = (isSelected: boolean, dashed = false) =>
  cn(
    'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs text-foreground disabled:pointer-events-none disabled:opacity-50',
    dashed && 'border-dashed',
    isSelected
      ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
      : 'border-input bg-background hover:bg-muted/50',
  );

/**
 * The single contact-first share screen. Pick recipients (typeahead +
 * address-book multi-select) → see the conversations you already have with all
 * of them → click one to share into it, or start a new one. First contact = one
 * conversation + one invite; later shares thread into the existing conversation
 * with no new invite (the duplicate-conversation/email fix).
 */
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
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { cloudUser } = useAuth();
  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();
  const { send, busy: sendBusy, error, resetDraft } = useSendToConversation();
  // Busy state for custom commits — useSendToConversation only tracks its own.
  const [commitBusy, setCommitBusy] = useState(false);
  const busy = sendBusy || commitBusy;

  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [titleInput, setTitleInput] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [attachTranscript, setAttachTranscript] = useState(true);
  // "Create bookmark" opt-in (default off): the receiver mints a favorite
  // pointing at the shared asset when it installs. Only offered for bookmarkable
  // sources (assets/artifacts).
  const [createBookmark, setCreateBookmark] = useState(false);
  // Which conversation row is selected (a conversation id, or NEW_CONVERSATION).
  // Click selects; double-click or the Share button commits.
  const [selected, setSelected] = useState<string>(NEW_CONVERSATION);
  const [sharedConversationId, setSharedConversationId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // A non-null id is the single source of truth for "share succeeded".
  const shared = sharedConversationId !== null;

  const effectiveProjectId = projectId ?? ctx.project?.id ?? null;
  const matches = useConversationsForContacts(participants, effectiveProjectId, open);
  const conversations = useMemo(
    () => matches.conversations.slice(0, MAX_CONVERSATIONS),
    [matches.conversations],
  );
  // Default selection follows the list: the latest existing conversation
  // (sorted updated_date desc by the hook), or "start new" when there are none.
  // Keyed on the latest id (not the array ref) so a background refetch that
  // returns the same list doesn't clobber the user's current selection.
  const latestConvId = conversations[0]?.id ?? null;
  useEffect(() => {
    setSelected(latestConvId ?? NEW_CONVERSATION);
  }, [latestConvId]);
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
    setParticipants(initialParticipantsRef.current ?? []);
    setTitleInput('');
    setNote(defaultNoteRef.current ?? '');
    setFiles([]);
    setAttachTranscript(true);
    setCreateBookmark(false);
    setSharedConversationId(null);
    setLocalError(null);
    resetDraft();
  }, [open, resetDraft]);

  const isRemote = hasRemoteParticipant(participants);
  const recipientEmails = useMemo(
    () =>
      participants
        .map((p) => normalizeEmail(p.email) || '')
        .filter((e) => !!e && e.includes('@')),
    [participants],
  );
  // The title is always editable. When the user hasn't typed one, fall back to
  // the source default / auto-generated title (shown as the input's placeholder).
  // `requiresTitle` sources have no fallback — the user must type one.
  const defaultTitle = source.requiresTitle ? '' : source.defaultTitle ?? newConvTitle;
  const effectiveTitle = (titleInput.trim() || defaultTitle).trim();
  const titleOk = !source.requiresTitle || titleInput.trim().length > 0;
  const canStartNew = participants.length > 0 && (isRemote || !!effectiveProjectId) && titleOk;
  const hasContacts = participants.length > 0;
  const isNewSelected = selected === NEW_CONVERSATION;
  // Git-transfer shares are blocked until the local checkout is clean + pushed.
  const gitGate = useGitShareGate(source.gitGate, open);
  const canShareSelected =
    !gitGate.blocked && !gitGate.loading &&
    (isNewSelected ? canStartNew : conversations.some((c) => c.id === selected));

  const doShare = async (existingId: string | null) => {
    if (busy) return;
    setLocalError(null);
    if (isRemote) {
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        setLocalError(gate.error);
        return;
      }
    }
    let payload: ConversationSendPayload;
    try {
      const prepared = await source.prepare({
        recipientEmails,
        senderName: localUser?.name ?? null,
        senderId: localUser?.id ?? null,
        title: effectiveTitle,
        projectId: effectiveProjectId,
        attachTranscript,
        files,
      });
      // `createBookmark` can only be true when the checkbox rendered, which
      // requires `source.bookmarkable` — no need to re-check it here.
      const baseShareConfig = prepared.shareConfig ?? source.shareConfig;
      const mergedShareConfig = createBookmark
        ? { ...(baseShareConfig ?? {}), createBookmark: true }
        : baseShareConfig;
      payload = {
        text: note.trim(),
        files: prepared.files,
        assetReferences: prepared.assetReferences,
        sharedContextEntities: prepared.sharedContextEntities,
        shareConfig: mergedShareConfig,
      };
      const target: SendTarget = existingId
        ? { kind: 'existing', conversationId: existingId }
        : {
            kind: 'new',
            params: {
              project_id: isRemote && !associateProjectOnRemote ? null : effectiveProjectId,
              participants,
              title: effectiveTitle,
              shared_context_entities: prepared.sharedContextEntities,
            },
          };
      let convId: string | null;
      if (commit) {
        setCommitBusy(true);
        try {
          convId = await commit(target, payload);
        } finally {
          setCommitBusy(false);
        }
      } else {
        convId = await send(target, payload);
      }
      if (convId) {
        setSharedConversationId(convId);
        onShared?.(convId);
      }
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Failed to share');
    }
  };

  const shownError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="share-to-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            {heading ?? <Trans>Share</Trans>}
          </DialogTitle>
        </DialogHeader>

        {shared ? (
          <div className="flex flex-col items-center gap-4 py-6 text-sm" data-testid="share-status">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
              <Check className="h-6 w-6" />
            </div>
            <p className="font-medium text-foreground"><Trans>Shared</Trans></p>
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
            <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-2 py-1.5 text-xs">
              <span className="flex-1 truncate text-foreground" title={source.label}>
                {source.label}
              </span>
              {source.typeLabel && (
                <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {source.typeLabel}
                </span>
              )}
            </div>

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
                    (source.requiresTitle
                      ? t`What do you need help with?`
                      : defaultTitle || t`Conversation title`)
                  }
                  disabled={busy}
                  data-testid="share-title-input"
                />
              </div>
            )}

            {!hideNote && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  <Trans>Note (optional)</Trans>
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t`Add a personal note…`}
                  rows={2}
                  disabled={busy}
                  className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="share-note-input"
                />
              </div>
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

            {gitGate.blocked && (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                data-testid="share-git-blocked"
              >
                {gitGate.dirtyFiles > 0 ? (
                  <Trans>
                    This app has {gitGate.dirtyFiles} uncommitted change(s). Commit and push before
                    sharing — the recipient clones from git, so unsaved work won't travel.
                  </Trans>
                ) : (
                  <Trans>
                    This app has {gitGate.unpushed} unpushed commit(s). Push before sharing — the
                    recipient clones from the remote. Use the git push button in the status bar.
                  </Trans>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                <Trans>Recent conversations</Trans>
              </label>
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
                          <span className="flex-1 truncate text-foreground">
                            {deriveConversationTitle(conv)}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {formatTimeAgo(
                              conv.updated_date ? new Date(conv.updated_date).toISOString() : null,
                            ) ?? ''}
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

            {shownError && <p className="text-xs text-destructive">{shownError}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                onClick={() => void doShare(isNewSelected ? null : selected)}
                disabled={busy || !canShareSelected}
                data-testid="share-submit"
                className="gap-1.5"
              >
                <Send className="h-4 w-4" />
                {busy ? t`Sharing…` : submitLabel ?? t`Share`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
