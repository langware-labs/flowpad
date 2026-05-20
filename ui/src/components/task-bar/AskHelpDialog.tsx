/**
 * AskHelpDialog — Scenario B entry point.
 *
 * Slim alternative to `EntityShareDialog`: no Spec, no transcript
 * attachment, no PTY assumption. The user just supplies a task title, a
 * recipient email, and an optional note. The recipient drives the task
 * forward by replying with a PROMPT, which the sender approves headlessly.
 */
import { useEffect, useRef, useState } from 'react';
import { Conversation, ConversationParticipant, Task, TypeId } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { toast } from 'sonner';

interface AskHelpDialogProps {
  open: boolean;
  onClose: () => void;
  /** Accepted for call-site compatibility; the conversation transport resolves
   *  the project from the sender's context, so this is no longer forwarded. */
  projectPath?: string;
}

export function AskHelpDialog({ open, onClose }: AskHelpDialogProps) {
  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const [recipients, setRecipients] = useState<ConversationParticipant[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous re-entry lock — ``busy`` is state and lags a render, so a
  // double-click can clear the guard twice. The draft refs hold the in-flight
  // Task + Conversation across retries: ``new Task()`` / ``new Conversation()``
  // mint a fresh uuid each call, so retrying with a new object orphans the hub
  // rows a prior attempt created. Reuse keeps the ids stable (upsert).
  const submittingRef = useRef(false);
  const draftTaskRef = useRef<Task | null>(null);
  const draftConvRef = useRef<Conversation | null>(null);

  useEffect(() => {
    if (open) {
      setRecipients([]);
      setTaskTitle('');
      setMessage('');
      setError(null);
      submittingRef.current = false;
      draftTaskRef.current = null;
      draftConvRef.current = null;
    }
  }, [open]);

  const recipientEmail = recipients[0]?.email?.trim() ?? '';
  const canSubmit = recipientEmail.length > 0 && taskTitle.trim().length > 0 && !busy;

  const handleSubmit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        setError(gate.error);
        return;
      }
      const effectiveTitle = taskTitle.trim();
      const recipientEmails = recipients
        .map((p) => (p.email || '').trim())
        .filter((email): email is string => !!email && email.includes('@'));
      if (recipientEmails.length === 0) {
        throw new Error('A recipient email is required');
      }

      // Mint the Task + Conversation once and reuse across retries (stable ids).
      // ``shared_context_entities`` is passed in the constructor — the new
      // shared-context API exposes no FE-side setter (sharing is a backend
      // decision); the constructor lifts the wire field into the private
      // ``_shared_context_entities_`` slot and ``save()`` ships it on the wire.
      const projectId = ctx.project?.id ?? null;
      const task = draftTaskRef.current ?? new Task({
        title: effectiveTitle,
        status: 'to_do',
        spec_type: 'request',
        sender_name: localUser?.name ?? undefined,
        recipient_email: recipientEmails[0],
        project_id: projectId,
      });
      draftTaskRef.current = task;

      const conv = draftConvRef.current ?? new Conversation({
        title: effectiveTitle,
        participants: recipients,
        shared_context_entities: [`${Task.type}-${task.id}`],
      } as Partial<Conversation>);
      conv.title = effectiveTitle;
      conv.participants = recipients;
      conv.project_id = projectId;
      draftConvRef.current = conv;

      await task.save();
      await conv.save();
      await conv.share(recipientEmails);

      // First message — text + the Task as a TYPE_ID attachment so it rides
      // the body bundle and materializes on the recipient. Same conversation
      // transport as New Conversation: WS delivery + delivery receipts.
      await sendReply(
        { conversationId: conv.id },
        message.trim(),
        undefined,
        { assetReferences: [`${Task.type}-${task.id}`] },
      );

      draftTaskRef.current = null;
      draftConvRef.current = null;
      toast.success('Help request sent.');
      navigation.openDock(DockPointer.forConversation(conv.id));
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send help request.';
      setError(msg);
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ask for help</DialogTitle>
          <DialogDescription>
            Send a task to someone — they'll reply with a PROMPT you can approve and run on your machine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Recipient</label>
            <ContactPicker
              value={recipients}
              onChange={setRecipients}
              excludeUserId={localUser?.id}
              max={1}
              disabled={busy}
              enabled={open}
              placeholder="Search contacts or type an email"
              testId="ask-help-recipient-input"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Task title</label>
            <Input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="What do you need help with?"
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Message (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Add a personal note..."
              rows={3}
              disabled={busy}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
