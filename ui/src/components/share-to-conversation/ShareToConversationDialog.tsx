import { useEffect, useState } from 'react';
import { Boxes, MessageSquarePlus, Send } from 'lucide-react';
import {
  hasRemoteParticipant,
  type AssetDescriptor,
  type ConversationParticipant,
  type ConversationSendPayload,
} from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useSendToConversation, type SendTarget } from '@src/hooks/use-send-to-conversation';
import { useConversationsForContacts } from '@src/hooks/use-conversations-for-contacts';
import { useAutoTitle } from '@src/hooks/use-auto-title';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import {
  displayLabelForTypeid,
  parseTypeid,
} from '@src/components/asset-manager/asset-row-helpers';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';

interface ShareToConversationDialogProps {
  open: boolean;
  onClose: () => void;
  /** Doc/entity being shared. Carried into the message as an asset reference. */
  assetDescriptor: AssetDescriptor;
  /** Scope existing-conversation results to a single project. Defaults to the active project. */
  projectId?: string | null;
}

/**
 * Contact-first share: pick contact(s) → see conversations with those people →
 * one-click row to send + navigate. The trailing "+ Start new" row creates a
 * fresh conversation with the same contacts (auto-titled) and sends in one shot.
 */
export function ShareToConversationDialog({
  open,
  onClose,
  assetDescriptor,
  projectId,
}: ShareToConversationDialogProps) {
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { cloudUser } = useAuth();
  const { send, busy, error, resetDraft } = useSendToConversation();
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);

  const effectiveProjectId = projectId ?? ctx.project?.id ?? null;
  const { conversations } = useConversationsForContacts(participants, effectiveProjectId, open);
  const newConvTitle = useAutoTitle(open, participants);

  useEffect(() => {
    if (!open) return;
    setParticipants([]);
    resetDraft();
  }, [open, resetDraft]);

  const isRemote = hasRemoteParticipant(participants);
  const canStartNew = participants.length > 0 && (isRemote || !!effectiveProjectId);

  const finalize = (conversationId: string | null) => {
    if (!conversationId) return;
    navigation.openDock(DockPointer.forConversation(conversationId));
    onClose();
  };

  const handlePickExisting = async (conversationId: string) => {
    const payload: ConversationSendPayload = {
      text: '',
      assetReferences: [assetDescriptor.typeid],
    };
    finalize(await send({ kind: 'existing', conversationId }, payload));
  };

  const handleStartNew = async () => {
    if (!canStartNew) return;
    const target: SendTarget = {
      kind: 'new',
      params: {
        project_id: isRemote ? null : effectiveProjectId,
        participants,
        title: newConvTitle,
      },
    };
    const payload: ConversationSendPayload = {
      text: '',
      assetReferences: [assetDescriptor.typeid],
    };
    finalize(await send(target, payload));
  };

  const docTypeLabel = parseTypeid(assetDescriptor.typeid).type;
  const docLabel = displayLabelForTypeid(assetDescriptor.typeid);
  const hasContacts = participants.length > 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="share-to-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            Share to conversation
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-2 py-1.5 text-xs">
            <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-foreground" title={assetDescriptor.typeid}>
              {docLabel}
            </span>
            <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {docTypeLabel}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              To
            </label>
            <ContactPicker
              value={participants}
              onChange={setParticipants}
              excludeUserId={cloudUser?.id ?? ctx.user?.id}
              enabled={open}
              testId="share-contact-picker"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Conversations
            </label>
            {!hasContacts ? (
              <p className="text-xs text-muted-foreground">
                Pick a contact to see your conversations with them.
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-1" data-testid="share-conversation-list">
                  {conversations.map((conv) => (
                    <li key={conv.id}>
                      <button
                        type="button"
                        onClick={() => void handlePickExisting(conv.id)}
                        disabled={busy}
                        className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-left text-xs hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
                        data-testid={`share-conv-row-${conv.id}`}
                      >
                        <span className="flex-1 truncate text-foreground">
                          {deriveConversationTitle(conv)}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatTimeAgo(
                            conv.updated_date
                              ? new Date(conv.updated_date).toISOString()
                              : null,
                          ) ?? ''}
                        </span>
                      </button>
                    </li>
                  ))}
                  <li>
                    <button
                      type="button"
                      onClick={() => void handleStartNew()}
                      disabled={busy || !canStartNew}
                      className="flex w-full items-center gap-2 rounded-md border border-dashed border-input bg-background px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
                      data-testid="share-conv-row-new"
                    >
                      <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="flex-1 truncate" title={newConvTitle}>
                        Start new · {newConvTitle}
                      </span>
                    </button>
                  </li>
                </ul>
                {conversations.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No existing conversations with these contacts — start one.
                  </p>
                )}
              </>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {busy ? 'Sending…' : 'Cancel'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
