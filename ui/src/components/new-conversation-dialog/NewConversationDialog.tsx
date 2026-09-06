import { Trans, useLingui } from '@lingui/react/macro';
import { ConversationParticipant, hasRemoteParticipant } from '@sdk';
import type { AssetDescriptor, ConversationSendPayload } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { useSendToConversation, type SendTarget } from '@src/hooks/use-send-to-conversation';
import { useAutoTitle } from '@src/hooks/use-auto-title';
import { AutofillInput } from '@src/components/ui/autofill-input';
import { Button } from '@src/components/ui/button';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { AttachMenu, AssetRefChips } from '@src/components/conversation/AttachMenu';
import { MAX_FILE_SIZE_BYTES } from '@src/components/conversation/constants';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SendProgressNotice } from '@src/components/conversation/SendProgressNotice';
import { Loader2, MessageSquarePlus, Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewConversationDialog({ open, onClose }: NewConversationDialogProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { projects = [] } = useProjects();
  const { cloudUser, localUser } = useAuth();
  const { send, busy, error, resetDraft } = useSendToConversation();

  const [projectId, setProjectId] = useState<string>('');
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [initialMessage, setInitialMessage] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [assetRefs, setAssetRefs] = useState<AssetDescriptor[]>([]);
  const [senderName, setSenderName] = useState('');
  const [editingName, setEditingName] = useState(false);

  // Reset the draft ONLY on the closed→open transition. Depending on the
  // ``projects`` array here wiped the form mid-typing: every project-row
  // update (the auto-indexer bumps it repeatedly on a fresh instance) yields a
  // new array identity, re-ran the reset, and dropped the participant the
  // user had just added — so Create stayed disabled with nothing to show why.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setParticipants([]);
      setInitialMessage('');
      setTitle('');
      setFiles([]);
      setAssetRefs([]);
      setEditingName(false);
      setProjectId(ctx.project?.id ?? projects[0]?.id ?? '');
      resetDraft();
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transition-gated; see above
  }, [open]);

  // The default project can arrive after the dialog opened; adopt it once,
  // without touching anything the user typed.
  useEffect(() => {
    if (!open || projectId) return;
    const fallback = ctx.project?.id ?? projects[0]?.id ?? '';
    if (fallback) setProjectId(fallback);
  }, [open, projectId, ctx.project?.id, projects]);

  useEffect(() => {
    const name = cloudUser?.name || cloudUser?.email || localUser?.name || '';
    if (name) setSenderName(name);
  }, [cloudUser?.email, cloudUser?.name, localUser?.name]);

  const isRemote = hasRemoteParticipant(participants);
  const autofillTitle = useAutoTitle(open, participants);
  const placeholderTitle = autofillTitle;

  const canCreate = !busy && (isRemote || !!projectId) && participants.length > 0 && !!initialMessage.trim();

  const handleCreate = async () => {
    if (!canCreate) return;
    const effectiveTitle = title.trim() || autofillTitle;
    const target: SendTarget = {
      kind: 'new',
      params: {
        project_id: isRemote ? null : projectId,
        participants,
        title: effectiveTitle,
      },
    };
    const payload: ConversationSendPayload = {
      text: initialMessage.trim(),
      files: files.length > 0 ? files : undefined,
      assetReferences: assetRefs.length > 0 ? assetRefs.map((a) => a.typeid) : undefined,
    };
    const conversationId = await send(target, payload);
    if (conversationId) {
      navigation.openDock(DockPointer.forConversation(conversationId));
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="new-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="h-5 w-5 text-primary" />
            {placeholderTitle}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          {isRemote && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">
                <Trans>From:</Trans>
              </span>
              {editingName ? (
                <input
                  className="border-b border-input bg-transparent text-xs text-foreground focus:outline-none"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  onBlur={() => {
                    setEditingName(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      setSenderName(cloudUser?.name || cloudUser?.email || localUser?.name || '');
                      setEditingName(false);
                    }
                  }}
                  autoFocus
                />
              ) : (
                <>
                  <span>{senderName || '...'}</span>
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    className="text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                    title={t`Edit sender name`}
                    disabled={busy}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Title — pre-filled from participants + date. Click to select and
              replace. After any keystroke the autofill is suppressed until the
              dialog reopens. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Title</Trans>
            </label>
            <AutofillInput
              autofill={autofillTitle}
              value={title}
              onChange={setTitle}
              data-testid="conversation-title-input"
            />
          </div>

          {/* Project — required for project-local conversations, optional for
              cross-user bundle conversations (stamped on the local Conversation
              and shipped as remote_project_id for the receiver's mapping). */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Project{isRemote ? ' (optional)' : ''}
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder={isRemote ? t`No project` : t`Select a project`} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id ?? ''}>
                    {p.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Participants */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Participants</Trans>
            </label>
            <ContactPicker
              value={participants}
              onChange={setParticipants}
              excludeUserId={cloudUser?.id ?? ctx.user?.id}
              enabled={open}
              testId="participant-input"
            />
          </div>

          {/* Initial message — required: a conversation always starts with one. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              <Trans>Initial message</Trans>
            </label>
            <textarea
              className="min-h-[80px] rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              placeholder={isRemote ? t`Say hi…` : t`Type your first message…`}
              data-testid="initial-message-input"
            />
          </div>

          {/* Attachments — dropzone for file drag/drop + small menu for File/Asset */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                <Trans>Attachments</Trans>
              </label>
              <AttachMenu
                assetRefs={assetRefs}
                onAssetRefsChange={setAssetRefs}
                onFilesPicked={(picked) => {
                  if (!picked) return;
                  const next = [...files];
                  for (const f of Array.from(picked)) {
                    if (f.size > MAX_FILE_SIZE_BYTES) continue;
                    if (!next.some((x) => x.name === f.name && x.size === f.size)) {
                      next.push(f);
                    }
                  }
                  setFiles(next);
                }}
                disabled={busy}
                hideAssetList
              />
            </div>
            {/* Asset chips render below the label row, not inside it: inside a
                flex row the chip list sizes to its content (min-width:auto),
                so a long asset label pushes the row past the dialog edge
                instead of truncating. */}
            <AssetRefChips assetRefs={assetRefs} onChange={setAssetRefs} disabled={busy} />
            <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center gap-2 pt-2">
          <SendProgressNotice busy={busy} hasAttachments={files.length > 0 || assetRefs.length > 0} />
          <div className="ms-auto flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!canCreate} className="gap-1.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? t`Creating…` : t`Create`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
