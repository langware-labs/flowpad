import {
  Conversation,
  ConversationParticipant,
  cloudManager,
  createProjectConversation,
  getErrorMessagesFromAxios,
} from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useProjects } from '@src/hooks/use-projects';
import { AutofillInput } from '@src/components/ui/autofill-input';
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
  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();

  const [projectId, setProjectId] = useState<string>('');
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [cloudUser, setCloudUser] = useState(cloudManager.currentUser);
  const [initialMessage, setInitialMessage] = useState('');
  const [title, setTitle] = useState('');
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
    setTitle('');
    setFiles([]);
    setError(null);
    setEditingName(false);
    setProjectId(ctx.project?.id ?? projects[0]?.id ?? '');
  }, [open, ctx.project?.id, projects]);

  useEffect(() => {
    if (!open) return;
    const syncCloudUser = () => setCloudUser(cloudManager.currentUser);
    syncCloudUser();
    cloudManager.on('login_complete', syncCloudUser);
    cloudManager.on('logout_complete', syncCloudUser);
    return () => {
      cloudManager.off('login_complete', syncCloudUser);
      cloudManager.off('logout_complete', syncCloudUser);
    };
  }, [open]);

  // Default sender name from the cloud user for cross-user communication.
  useEffect(() => {
    const name = cloudUser?.name || cloudUser?.email || localUser?.name || '';
    if (name) setSenderName(name);
  }, [cloudUser?.email, cloudUser?.name, localUser?.name]);

  // Cross-user mode: any participant with a user id or email triggers the bundle
  // delivery flow (startBundleConversation). Otherwise we keep the
  // project-local-only path.
  const hasRemoteParticipant = participants.some(
    (p) => !!p.user_id || (!!p.email && p.email.includes('@')),
  );

  // Slack-style autofill: "<my name>, <participant1>, ... - <Mon D>". Open-dialog
  // sets the date once so the autofill is stable across re-renders within a session.
  const myLabel = cloudUser?.name || cloudUser?.email || ctx.user?.name || ctx.user?.email || 'You';
  const openedAt = useMemo(() => new Date(), [open]);
  const dateSuffix = useMemo(
    () => openedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    [openedAt],
  );
  const autofillTitle = useMemo(() => {
    if (participants.length === 0) return `New conversation - ${dateSuffix}`;
    const others = participants.map((p) => p.name || p.email || 'unknown').join(', ');
    return `${myLabel}, ${others} - ${dateSuffix}`;
  }, [participants, myLabel, dateSuffix]);
  // Dialog heading mirrors the autofill so the header stays a live preview.
  const placeholderTitle = autofillTitle;

  // Cross-user bundle conversations don't require a Project; local-only ones do.
  const canCreate = !busy && (hasRemoteParticipant || !!projectId) && participants.length > 0;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const hasFiles = files.length > 0;
      const message = initialMessage.trim();
      const effectiveTitle = title.trim() || autofillTitle;

      let conversationId: string | null;

      if (hasRemoteParticipant) {
        // Cross-user create routes through hub; require cloud login first so a
        // logged-out user is taken through OAuth and the create resumes on the
        // same click instead of failing silently.
        const gate = await ensureCloudLogin();
        if (!gate.ok) {
          setError(gate.error);
          return;
        }
        // Standard share + invite pattern: create the conversation locally,
        // ``conv.share(recipients)`` POSTs to the hub and sends one
        // ``MembershipRequest`` per recipient via ``/members``. Recipients see
        // a pending invitation in their UI; on accept their local backend
        // ``conversation/<id>/join``s so they enter ``participants`` and start
        // receiving WS fanout.
        const recipientEmails = participants
          .map((p) => (p.email || '').trim())
          .filter((email): email is string => !!email && email.includes('@'));
        if (recipientEmails.length === 0) {
          throw new Error('At least one recipient email is required');
        }
        const conv = new Conversation({ title: effectiveTitle, participants });
        await conv.save();
        await conv.share(recipientEmails);
        if (!hasFiles && message) {
          // Initial message goes through the standard ``add_message`` path so
          // the hub fanouts the FlowMessage to invited (post-accept) participants.
          await conv.addMessage(message);
        }
        conversationId = conv.id;
      } else {
        const result = await createProjectConversation({
          project_id: projectId,
          participants,
          title: effectiveTitle,
        });
        conversationId = result.conversation_id;
      }

      if (hasFiles && conversationId) {
        await sendReply({ conversationId }, message, files);
      }

      if (conversationId) {
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
          {hasRemoteParticipant && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">From:</span>
              {editingName ? (
                <input
                  className="border-b border-input bg-transparent text-xs text-foreground focus:outline-none"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  onBlur={async () => {
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

          {/* Title — pre-filled from participants + date. Click to select and
              replace. After any keystroke the autofill is suppressed until the
              dialog reopens. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Title
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
              Project{hasRemoteParticipant ? ' (optional)' : ''}
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder={hasRemoteParticipant ? 'No project' : 'Select a project'} />
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
              excludeUserId={cloudUser?.id ?? ctx.user?.id}
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
              placeholder={hasRemoteParticipant ? 'Say hi…' : 'Optional'}
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
