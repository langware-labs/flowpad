/**
 * AskHelpDialog — Scenario B entry point.
 *
 * Slim alternative to `AskForAssistanceDialog`: no Spec, no transcript
 * attachment, no PTY assumption. The user just supplies a task title, a
 * recipient email, and an optional note. The recipient drives the task
 * forward by replying with a PROMPT, which the sender approves headlessly.
 */
import { useEffect, useState } from 'react';
import { ConversationParticipant } from '@sdk';
import { sendNotification } from '@sdk/entities/notifications';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
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
  /** Active project / cwd; forwarded to the share-task action so the recipient can map it. */
  projectPath?: string;
}

export function AskHelpDialog({ open, onClose, projectPath }: AskHelpDialogProps) {
  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();
  const [recipients, setRecipients] = useState<ConversationParticipant[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRecipients([]);
      setTaskTitle('');
      setMessage('');
      setError(null);
    }
  }, [open]);

  const recipientEmail = recipients[0]?.email?.trim() ?? '';
  const canSubmit = recipientEmail.length > 0 && taskTitle.trim().length > 0 && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        setError(gate.error);
        return;
      }
      const result = await sendNotification({
        recipient_id: recipientEmail,
        // Empty Spec — backend skips the Spec entity when both fields are blank
        // (Scenario B: "I need help" tasks don't carry a written specification).
        spec_title: '',
        spec_content: '',
        spec_type: 'request',
        task_title: taskTitle.trim(),
        message: message.trim() || null,
        project_path: projectPath ?? null,
        sender_name: localUser?.name ?? null,
      });
      if (result.email_error) {
        toast.warning('Task created, but the notification email could not be sent.');
      } else {
        toast.success('Help request sent.');
      }
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send help request.';
      setError(msg);
    } finally {
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
