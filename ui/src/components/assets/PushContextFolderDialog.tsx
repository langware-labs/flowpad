import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquarePlus, Upload } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { hasRemoteParticipant, type ConversationParticipant, type GitPushResult } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useConversationsForContacts } from '@src/hooks/use-conversations-for-contacts';
import { useSendToConversation, type SendTarget } from '@src/hooks/use-send-to-conversation';
import { notify } from '@src/notifications';
import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { cn } from '@src/lib/utils';
import { formatTimeAgo } from '@src/utils/format-time-ago';

const MAX_CONVERSATIONS = 5;

/** Sentinel for the "start a new conversation" row (never a real UUID). */
const NEW_CONVERSATION = '__new__';

/** Same selectable-row styling as ShareToConversationDialog. */
const rowClasses = (isSelected: boolean, dashed = false) =>
  cn(
    'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs text-foreground disabled:pointer-events-none disabled:opacity-50',
    dashed && 'border-dashed',
    isSelected ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-input bg-background hover:bg-muted/50',
  );

interface PushContextFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Basename of the git context folder (for titles/labels). */
  folderName: string;
  /** Current branch, shown in the header line. */
  branch?: string | null;
  /** Scoped project id — anchors the recent-conversation search and new
   *  project-local conversations. */
  projectId?: string | null;
  /** The context folder's Folder entity typeid — attached to the message as
   *  the git-link chip (recipients click it to pull a local copy). */
  folderTypeId?: string | null;
  /** The actual git push (from useGitFolderStatus). */
  push: () => Promise<GitPushResult | null>;
  pushing: boolean;
}

/**
 * PushContextFolderDialog — the Push flow for a git context folder. Always
 * pushes; optionally notifies. The user writes a message and picks recipients
 * (a contacts group expands to its members in one click), then chooses the
 * target conversation — an existing one with those recipients or a new one
 * (same list pattern as ShareToConversationDialog). On submit: push first;
 * only a successful push sends the message. Delivery to each member rides the
 * existing conversation create/share machinery.
 */
export function PushContextFolderDialog({
  open,
  onOpenChange,
  folderName,
  branch,
  projectId,
  folderTypeId,
  push,
  pushing,
}: PushContextFolderDialogProps) {
  const { t } = useLingui();
  const ctx = useDataContext();
  const { cloudUser } = useAuth();
  const { send, busy: sendBusy, error: sendError, resetDraft } = useSendToConversation();

  const [notifyChecked, setNotifyChecked] = useState(false);
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string>(NEW_CONVERSATION);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = pushing || sendBusy;

  const effectiveProjectId = projectId ?? ctx.project?.id ?? null;
  const matches = useConversationsForContacts(participants, effectiveProjectId, open);
  const conversations = useMemo(() => matches.conversations.slice(0, MAX_CONVERSATIONS), [matches.conversations]);
  const latestConvId = conversations[0]?.id ?? null;
  useEffect(() => {
    setSelected(latestConvId ?? NEW_CONVERSATION);
  }, [latestConvId]);

  useEffect(() => {
    if (!open) return;
    setNotifyChecked(false);
    setParticipants([]);
    setMessage('');
    setSelected(NEW_CONVERSATION);
    setLocalError(null);
    resetDraft();
  }, [open, resetDraft]);

  const notifying = notifyChecked && participants.length > 0;
  const isRemote = hasRemoteParticipant(participants);
  const isNewSelected = selected === NEW_CONVERSATION;
  const title = t`Pushed ${folderName}`;
  // Push-only is always allowed; with "Notify" checked the submit additionally
  // needs recipients, a message, and a valid conversation home (remote
  // recipients, or a project for local convs).
  const canSubmit =
    !busy &&
    (!notifyChecked || (participants.length > 0 && message.trim().length > 0 && (isRemote || !!effectiveProjectId)));

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLocalError(null);
    const result = await push();
    if (!result) return;
    if (!result.ok) {
      setLocalError(result.message);
      notify.error({ title: t`Push failed`, message: result.message });
      return;
    }
    if (!notifying) {
      notify.success({ title: result.nothing ? t`Nothing to push` : t`Pushed to remote` });
      onOpenChange(false);
      return;
    }
    const target: SendTarget =
      isNewSelected || !conversations.some((c) => c.id === selected)
        ? {
            kind: 'new',
            params: {
              project_id: isRemote ? null : effectiveProjectId,
              participants,
              title,
            },
          }
        : { kind: 'existing', conversationId: selected };
    // The git-link chip: the context folder's Folder entity rides as a
    // TYPE_ID attachment in git transfer mode — metadata + origin only, zero
    // repo bytes. Recipients click it to set up their own local copy.
    const chipRefs = folderTypeId ? [folderTypeId] : undefined;
    const convId = await send(target, {
      text: message.trim(),
      assetReferences: chipRefs,
      sharedContextEntities: chipRefs,
      shareConfig: chipRefs ? { transferMode: 'git' } : undefined,
    });
    if (!convId) return; // sendError renders inline; keep the dialog open.
    notify.success({
      title: result.nothing ? t`Nothing new to push — message sent` : t`Pushed and message sent`,
    });
    onOpenChange(false);
  };

  const shownError = localError ?? sendError;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="push-context-folder-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            <Trans>Push {folderName}</Trans>
          </DialogTitle>
          <DialogDescription>
            {branch ? (
              <Trans>Push to {branch} — optionally tell people about it.</Trans>
            ) : (
              <Trans>Push to the remote — optionally tell people about it.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={notifyChecked}
              onChange={(e) => setNotifyChecked(e.target.checked)}
              disabled={busy}
              data-testid="push-notify-checkbox"
            />
            <Trans>Notify people about this push</Trans>
          </label>

          {notifyChecked && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                <Trans>Message</Trans>
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t`What changed? Sent to the recipients below…`}
                rows={2}
                disabled={busy}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="push-message-input"
              />
            </div>
          )}

          {notifyChecked && (
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
                    enabled={open && notifyChecked}
                    disabled={busy}
                    placeholder={t`Pick a contacts group or people`}
                    testId="push-contact-picker"
                  />
                </div>
                <AddressBookButton
                  value={participants}
                  onChange={setParticipants}
                  excludeUserId={cloudUser?.id ?? ctx.user?.id}
                  enabled={open && notifyChecked}
                  disabled={busy}
                />
              </div>
            </div>
          )}

          {notifying && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                <Trans>Conversation</Trans>
              </label>
              <ul className="flex flex-col gap-1" data-testid="push-conversation-list">
                {conversations.map((conv) => {
                  const isSelected = selected === conv.id;
                  return (
                    <li key={conv.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(conv.id)}
                        disabled={busy}
                        aria-pressed={isSelected}
                        data-selected={isSelected}
                        className={rowClasses(isSelected)}
                        data-testid={`push-conv-row-${conv.id}`}
                      >
                        <span className="flex-1 truncate text-foreground">{deriveConversationTitle(conv)}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatTimeAgo(conv.updated_date ? new Date(conv.updated_date).toISOString() : null) ?? ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
                <li className={cn(conversations.length > 0 && 'mt-2 border-t border-border/60 pt-2')}>
                  <button
                    type="button"
                    onClick={() => setSelected(NEW_CONVERSATION)}
                    disabled={busy}
                    aria-pressed={isNewSelected}
                    data-selected={isNewSelected}
                    className={rowClasses(isNewSelected, true)}
                    data-testid="push-conv-row-new"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="flex-1 truncate" title={title}>
                      <Trans>Start new conversation · {title}</Trans>
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          )}

          {shownError && <p className="text-xs text-destructive">{shownError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              data-testid="push-submit"
              className="gap-1.5"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {notifyChecked ? t`Push & notify` : t`Push`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
