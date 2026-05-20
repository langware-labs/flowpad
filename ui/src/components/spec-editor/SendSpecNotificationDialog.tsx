/**
 * SendPlanNotificationDialog - Share a plan as a task.
 * Supports two delivery modes:
 *   Share via Email — sends via Flowpad Hub (requires recipient)
 *   Share via Repo  — coming soon (disabled)
 * A download icon in the top-left lets the user save a .flowmsg file locally.
 */

import { useEffect, useRef, useState } from 'react';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { useContext } from '@sdk/react/hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { sendReply } from '@sdk/entities/notifications';
import { createTaskBundle, DeliveryMode } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import {
  AgenticProcess,
  Conversation,
  dataManager,
  oauthService,
  OAUTH_PROVIDERS,
  Spec,
  Task,
  TypeId,
  type ConversationParticipant,
} from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { toast } from 'sonner';
import { Mail, Download, Github, Pencil } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';

/** Extract first # heading from markdown, fall back to filename stem. */
function extractTitle(markdown: string, filePath: string): string {
  for (const line of markdown.split('\n')) {
    const stripped = line.replace(/^#+\s*/, '').trim();
    if (stripped) return stripped;
  }
  const stem = filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled Plan';
  return stem;
}

interface SendPlanNotificationDialogProps {
  open: boolean;
  onClose: () => void;
  planFilePath: string;
  planContent: string;
  /** Accepted for call-site compatibility; the conversation transport resolves
   *  the project from the sender's context, so this is no longer forwarded. */
  workdir?: string | null;
  /** Active AgenticProcess id where the plan was authored — stamped onto the sender's task as my_process_id, then pre-forked so the recipient inherits its conversational context. */
  processId?: string;
}

export function SendPlanNotificationDialog({
  open,
  onClose,
  planFilePath,
  planContent,
  processId,
}: SendPlanNotificationDialogProps) {
  const ctx = useContext();
  const { cloudLoginAvailable } = ctx;
  const dataCtx = useDataContext();
  const { navigation } = useDockNavigation();
  const { localUser, updateName } = useLocalUser();
  const [mode, setMode] = useState<DeliveryMode>(DeliveryMode.EMAIL);
  const [recipients, setRecipients] = useState<ConversationParticipant[]>([]);
  const [specTitle, setSpecTitle] = useState('');
  const [specContent, setSpecContent] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [senderName, setSenderName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Synchronous re-entry lock + draft refs holding the in-flight Spec / Task /
  // Conversation across retries so a retry reuses stable ids (upsert) instead
  // of orphaning the hub rows a prior attempt created.
  const submittingRef = useRef(false);
  const draftSpecRef = useRef<Spec | null>(null);
  const draftTaskRef = useRef<Task | null>(null);
  const draftConvRef = useRef<Conversation | null>(null);

  useEffect(() => {
    if (open) {
      setSpecTitle(extractTitle(planContent, planFilePath));
      setSpecContent(planContent);
      setRecipients([]);
      setMessage('Hi,\nGot a new task for you.\nLMK if you have any questions.\nGood luck!');
      setFiles([]);
      setError(null);
      setSuccess(false);
      setEditingName(false);
      submittingRef.current = false;
      draftSpecRef.current = null;
      draftTaskRef.current = null;
      draftConvRef.current = null;
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (localUser?.name) setSenderName(localUser.name);
  }, [localUser?.name]);

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleEmail = async () => {
    const recipient = recipients[0];
    const recipientId = recipient?.email?.trim() ?? '';
    if (!recipientId || !specTitle.trim() || busy || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Pre-fork the live session so the recipient's headless runs (e.g.
      // "Request status") resume from the session that authored the plan
      // instead of spawning fresh context. Best-effort — fork failure
      // shouldn't block the share.
      const proc = processId
        ? await dataManager.getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, processId)).catch(() => null)
        : null;
      let forkedProcessId: string | null = null;
      if (proc) {
        try {
          const forked = await proc.fork(false);
          forkedProcessId = forked.id ?? null;
        } catch (forkErr) {
          console.warn('[SendPlanNotificationDialog] pre-fork failed (non-fatal):', forkErr);
        }
      }

      const effectiveTitle = specTitle.trim();
      const recipientEmails = recipients
        .map((p) => (p.email || '').trim())
        .filter((email): email is string => !!email && email.includes('@'));
      if (recipientEmails.length === 0) {
        throw new Error('A recipient email is required');
      }

      // Mint Spec + Task + Conversation once; reuse across retries (stable ids).
      // ``shared_process_id`` rides the bundle to the recipient (whitelisted
      // into ``_TASK_FIELDS``); ``my_process_id`` is sender-only — set so the
      // sender's "Open Claude Code" chip works; the packer strips it on send.
      const projectId = dataCtx.project?.id ?? null;
      const spec = draftSpecRef.current ?? new Spec({
        title: effectiveTitle,
        content: specContent.trim(),
        spec_type: 'plan',
      });
      spec.title = effectiveTitle;
      spec.content = specContent.trim();
      draftSpecRef.current = spec;

      const task = draftTaskRef.current ?? new Task({
        title: effectiveTitle,
        status: 'to_do',
        spec_type: 'plan',
        sender_name: senderName.trim() || undefined,
        recipient_email: recipientEmails[0],
        project_id: projectId,
        my_process_id: processId ?? null,
      });
      task.shared_process_id = forkedProcessId;
      task.addContextEntity(new TypeId(Spec.type, spec.id));
      draftTaskRef.current = task;

      const conv = draftConvRef.current ?? new Conversation({
        title: effectiveTitle,
        participants: recipients,
      });
      conv.title = effectiveTitle;
      conv.participants = recipients;
      conv.project_id = projectId;
      draftConvRef.current = conv;

      // Cross-link Task <-> Conversation via context_entities (both ways).
      conv.addContextEntity(new TypeId(Task.type, task.id));
      task.addContextEntity(new TypeId(Conversation.type, conv.id));

      await spec.save();
      await task.save();
      await conv.save();
      await conv.share(recipientEmails);

      // First message — text + user files + Spec & Task as TYPE_ID attachments
      // so they ride the body bundle and materialize on the recipient. Same
      // conversation transport as New Conversation: WS delivery + receipts.
      await sendReply(
        { conversationId: conv.id },
        message.trim(),
        files.length > 0 ? files : undefined,
        {
          assetReferences: [
            `${Task.type}-${task.id}`,
            `${Spec.type}-${spec.id}`,
          ],
        },
      );

      draftSpecRef.current = null;
      draftTaskRef.current = null;
      draftConvRef.current = null;
      setSuccess(true);
      toast.success('Task shared successfully!');
      navigation.openDock(DockPointer.forConversation(conv.id));
      setTimeout(() => onClose(), 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send notification.';
      setError(msg);
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!specTitle.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createTaskBundle({
        spec_title: specTitle.trim(),
        spec_content: specContent.trim(),
        task_title: specTitle.trim(),
        message: message.trim() || null,
        team_space_id: null,
      });
      const url = new ActionInfo('file-download', 'flow_message', result.flow_message_id, 'GET').fullActionUrl;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task bundle.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = recipients.length > 0 && specTitle.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Share Task</DialogTitle>
            <DialogDescription>
              This plan will be packaged as a spec and shared as a new task.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Mode toggle */}
            <div className="flex rounded-md border border-input p-0.5">
              <button
                type="button"
                onClick={() => setMode(DeliveryMode.EMAIL)}
                disabled={busy}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded py-1.5 text-sm font-medium transition-colors',
                  mode === DeliveryMode.EMAIL
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Mail className="h-3.5 w-3.5" />
                Share via Email
              </button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex flex-1 cursor-not-allowed items-center justify-center gap-2 rounded py-1.5 text-sm font-medium text-muted-foreground opacity-40">
                      <Github className="h-3.5 w-3.5" />
                      Share via Repo
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Coming Soon</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            {/* From */}
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
                    if (e.key === 'Escape') { setSenderName(localUser?.name ?? ''); setEditingName(false); }
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

            {/* Recipient */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Recipient</label>
              <ContactPicker
                value={recipients}
                onChange={setRecipients}
                excludeUserId={ctx.user?.id}
                max={1}
                disabled={busy}
                enabled={open}
                placeholder="Search contacts or type an email"
                testId="plan-recipient-input"
              />
            </div>

            {/* Spec title */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Spec title</label>
              <Input
                value={specTitle}
                onChange={(e) => setSpecTitle(e.target.value)}
                placeholder="Title"
                disabled={busy}
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <textarea
                value={specContent}
                onChange={(e) => setSpecContent(e.target.value)}
                rows={6}
                disabled={busy}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Message (optional)</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a personal note..."
                rows={4}
                disabled={busy}
                className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {success && <p className="text-xs text-green-600 dark:text-green-400">Task shared successfully.</p>}
          </div>

          <DialogFooter className="sm:justify-between">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void handleDownload()}
                    disabled={!specTitle.trim() || busy}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download .flowmsg</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!cloudLoginAvailable) {
                  (window as any).__postCloudLoginCallback = async () => {
                    await handleEmail();
                    await new Promise(resolve => setTimeout(resolve, 1500));
                  };
                  void oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
                  return;
                }
                void handleEmail();
              }}
              disabled={!canSubmit}
            >
              {busy ? 'Sending...' : 'Share Task'}
            </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
