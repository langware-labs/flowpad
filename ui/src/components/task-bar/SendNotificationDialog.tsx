/**
 * SendNotificationDialog - Compose and send a cross-user notification from a task.
 * POSTs to /api/v1/graph/notification/send with sub_action="send".
 */

import { useEffect, useState } from 'react';
import type { Task } from '@sdk';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { sendNotification } from '@sdk/entities/notifications';
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

const SPEC_TYPES = [
  { value: 'plan', label: 'Plan' },
  { value: 'issue', label: 'Issue' },
  { value: 'support_ticket', label: 'Support Ticket' },
] as const;

type SpecType = (typeof SPEC_TYPES)[number]['value'];

interface SendNotificationDialogProps {
  task: Task;
  open: boolean;
  onClose: () => void;
}

export function SendNotificationDialog({ task, open, onClose }: SendNotificationDialogProps) {
  const [teamSpaceId, setTeamSpaceId] = useState(
    () => localStorage.getItem('flowpad.sendNotification.lastTeamSpace') ?? '',
  );
  const [recipientId, setRecipientId] = useState('');
  const [specType, setSpecType] = useState<SpecType>('plan');
  const [specTitle, setSpecTitle] = useState('');
  const [specContent, setSpecContent] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Pre-populate spec title from task when dialog opens
  useEffect(() => {
    if (open) {
      setSpecTitle(task.title || '');
      setRecipientId('');
      setSpecContent('');
      setMessage('Hi,\nGot a new task for you.\nLMK if you have any questions.\nGood luck!');
      setFiles([]);
      setError(null);
      setSuccess(false);
    }
  }, [open, task.title]);

  const handleClose = () => {
    if (sending) return;
    onClose();
  };

  const handleSend = async () => {
    if (!recipientId.trim() || !specTitle.trim()) return;
    setSending(true);
    setError(null);

    try {
      if (teamSpaceId.trim()) {
        localStorage.setItem('flowpad.sendNotification.lastTeamSpace', teamSpaceId.trim());
      }
      await sendNotification({
        recipient_id: recipientId.trim(),
        spec_title: specTitle.trim(),
        spec_content: specContent.trim(),
        spec_type: specType,
        task_title: task.title || '',
        task_id: task.id ?? null,
        message: message.trim() || null,
        plan_id: null,
        project_path: null,
        team_space_id: teamSpaceId.trim() || null,
      });

      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send notification.';
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  const canSend = recipientId.trim().length > 0 && specTitle.trim().length > 0 && !sending;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send Notification</DialogTitle>
          {task.title && (
            <DialogDescription>
              Share a spec based on: <span className="font-medium text-foreground">{task.title}</span>
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Team Space */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Team Space (optional)</label>
            <Input
              value={teamSpaceId}
              onChange={(e) => setTeamSpaceId(e.target.value)}
              placeholder="e.g. hw-demo"
              disabled={sending}
            />
          </div>

          {/* Recipient */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Recipient email or user ID</label>
            <Input
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              placeholder="user@example.com or user ID"
              autoFocus
              disabled={sending}
            />
          </div>

          {/* Spec type */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Spec type</label>
            <div className="flex gap-1.5">
              {SPEC_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  disabled={sending}
                  onClick={() => setSpecType(t.value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    specType === t.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Spec title */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Spec title</label>
            <Input
              value={specTitle}
              onChange={(e) => setSpecTitle(e.target.value)}
              placeholder="Title"
              disabled={sending}
            />
          </div>

          {/* Spec content / plan */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Context / Plan</label>
            <textarea
              value={specContent}
              onChange={(e) => setSpecContent(e.target.value)}
              placeholder="Describe the spec, plan, or issue in markdown..."
              rows={4}
              disabled={sending}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Optional message */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Message (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Add a personal note..."
              rows={4}
              disabled={sending}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <FileAttachmentPicker files={files} onChange={setFiles} disabled={sending} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {success && <p className="text-xs text-green-600 dark:text-green-400">Notification sent successfully.</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void handleSend()} disabled={!canSend}>
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
