import {
  Conversation,
  ConversationParticipant,
  createProjectConversation,
  getErrorMessagesFromAxios,
  startBundleConversation,
} from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { Button } from '@src/components/ui/button';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { MessageSquarePlus, Pencil } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewConversationDialog({ open, onClose }: NewConversationDialogProps) {
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { projects = [] } = useProjects();
  const { localUser, updateName } = useLocalUser();

  const [projectId, setProjectId] = useState<string>('');
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [initialMessage, setInitialMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [senderName, setSenderName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the project picker to the current project on open.
  useEffect(() => {
    if (!open) return;
    setParticipants([]);
    setInitialMessage('');
    setFiles([]);
    setError(null);
    setEditingName(false);
    setProjectId(ctx.project?.id ?? projects[0]?.id ?? '');
  }, [open, ctx.project?.id, projects]);

  // Default sender name from git-synced local user. Mirror SendSpecNotificationDialog.
  useEffect(() => {
    if (localUser?.name) setSenderName(localUser.name);
  }, [localUser?.name]);

  // Cross-user mode: any participant addressed by email triggers the bundle
  // delivery flow (startBundleConversation). Otherwise we keep the
  // project-local-only path.
  const hasEmailParticipant = participants.some(
    (p) => !!p.email && p.email.includes('@'),
  );

  // Slack-style placeholder: "<my name>, <participant1>, ..."
  const myLabel = ctx.user?.name || ctx.user?.email || 'You';
  const placeholderTitle = useMemo(() => {
    if (participants.length === 0) return 'New conversation';
    const others = participants.map((p) => p.name || p.email).join(', ');
    return `${myLabel}, ${others}`;
  }, [participants, myLabel]);

  // Cross-user bundle conversations don't require a Project; local-only ones do.
  const canCreate = !busy && (hasEmailParticipant || !!projectId) && participants.length > 0;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const hasFiles = files.length > 0;
      const message = initialMessage.trim();

      let conversationId: string | null;
      let projectIdForNav: string | null = null;

      if (hasEmailParticipant) {
        // Bundle delivery — same path as share_task / AskForAssistance, just
        // without a Task/Spec. Backend stamps project_id on the local
        // Conversation at create time and includes it as remote_project_id in
        // the bundle for the receiver's project-mapping flow.
        const recipient = participants.find((p) => !!p.email)?.email || '';
        // ``message`` is sent as the initial-message body when there are no
        // file attachments. With files, defer to the follow-up sendReply so
        // attachments ride a single FormData call.
        const result = await startBundleConversation({
          recipient_id: recipient,
          message: hasFiles ? undefined : (message || undefined),
          project_id: projectId || null,
          sender_name: senderName.trim() || null,
        });
        conversationId = result.conversation_id ?? null;
        if (!conversationId) {
          throw new Error(result.email_error || 'Failed to start conversation');
        }
      } else {
        const result = await createProjectConversation({
          project_id: projectId,
          participants,
        });
        conversationId = result.conversation_id;
        projectIdForNav = result.project_id;
      }

      if (hasFiles && conversationId) {
        await sendReply({ conversationId }, message, files);
      }

      if (projectIdForNav && conversationId) {
        navigation.openDock(
          DockPointer.forProject(projectIdForNav, { conversationId }),
        );
      } else if (conversationId) {
        navigation.openDock(DockPointer.forConversation(conversationId));
      }
      onClose();
    } catch (err: unknown) {
      // Axios errors carry the backend's `message` field on `error.response.data`;
      // `err.message` would just be "Request failed with status code 400".
      const fromAxios = await getErrorMessagesFromAxios(err);
      const msg = fromAxios || (err instanceof Error ? err.message : '') || 'Failed to create conversation';
      setError(msg);
    } finally {
      setBusy(false);
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
          {hasEmailParticipant && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">From:</span>
              {editingName ? (
                <input
                  className="border-b border-input bg-transparent text-xs text-foreground focus:outline-none"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  onBlur={async () => {
                    setEditingName(false);
                    if (senderName.trim() && senderName.trim() !== localUser?.name) {
                      await updateName(senderName.trim());
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      setSenderName(localUser?.name ?? '');
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
                    className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    title="Edit sender name"
                    disabled={busy}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Project — required for project-local conversations, optional for
              cross-user bundle conversations (stamped on the local Conversation
              and shipped as remote_project_id for the receiver's mapping). */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Project{hasEmailParticipant ? ' (optional)' : ''}
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder={hasEmailParticipant ? 'No project' : 'Select a project'} />
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
              Participants
            </label>
            <ContactPicker
              value={participants}
              onChange={setParticipants}
              excludeUserId={ctx.user?.id}
              enabled={open}
              testId="participant-input"
            />
          </div>

          {/* Initial message */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Initial message
            </label>
            <textarea
              className="min-h-[80px] rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              placeholder={hasEmailParticipant ? 'Say hi…' : 'Optional'}
              data-testid="initial-message-input"
            />
          </div>

          {/* Attachments */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Attachments
            </label>
            <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for type completeness
export type { Conversation };
