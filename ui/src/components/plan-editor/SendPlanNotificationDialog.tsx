/**
 * SendPlanNotificationDialog - Share a plan as a task notification.
 * Pre-populates spec content from the current plan markdown.
 * POSTs to /api/v1/graph/notification/send to create a Spec + Task + CrossUserNotification.
 */

import { useEffect, useState } from 'react';
import { useContext } from '@sdk/react/hooks';
import { sendNotification } from '@sdk/entities/notifications';
import { oauthService, OAUTH_PROVIDERS } from '@sdk';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';

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
  workdir?: string | null;
}

export function SendPlanNotificationDialog({
  open,
  onClose,
  workdir,
  planFilePath,
  planContent,
}: SendPlanNotificationDialogProps) {
  const { cloudLoginAvailable } = useContext();
  const [recipientId, setRecipientId] = useState('');
  const [specTitle, setSpecTitle] = useState('');
  const [specContent, setSpecContent] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Pre-populate from plan when dialog opens
  useEffect(() => {
    if (open) {
      setSpecTitle(extractTitle(planContent, planFilePath));
      setSpecContent(planContent);
      setRecipientId('');
      setMessage('Hi,\nGot a new task for you.\nLMK if you have any questions.\nGood luck!');
      setError(null);
      setSuccess(false);
      setGitError(null);
      setEmailError(null);
    }
  }, [open, planContent, planFilePath]);

  const handleClose = () => {
    if (sending) return;
    onClose();
  };

  const handleSend = async () => {
    if (!recipientId.trim() || !specTitle.trim()) return;
    setSending(true);
    setError(null);

    try {
      const result = await sendNotification({
        recipient_id: recipientId.trim(),
        spec_title: specTitle.trim(),
        spec_content: specContent.trim(),
        spec_type: 'plan',
        task_title: specTitle.trim(),
        task_id: null,
        message: message.trim() || null,
        plan_id: null,
        project_path: workdir ?? null,
      });
      if (result.git_error) {
        setGitError(result.git_error);
      } else if (result.email_error) {
        setSuccess(true);
        setEmailError(result.email_error);
        toast.warning('Task created, but the notification email could not be sent. Check your activity panel.');
        setTimeout(() => onClose(), 5000);
      } else {
        setSuccess(true);
        toast.success('Task shared successfully!');
        setTimeout(() => onClose(), 1200);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send notification.';
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  const canSend = recipientId.trim().length > 0 && specTitle.trim().length > 0 && !sending;

  return (
    <>
    <AlertDialog open={!!gitError} onOpenChange={(o) => { if (!o) { setGitError(null); onClose(); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Git Push Failed</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p className="mb-2">The task could not be pushed to the remote repository. Please fix the git issue below and send the task again.</p>
              <pre className="max-h-40 overflow-auto rounded bg-muted px-3 py-2 text-xs text-foreground whitespace-pre-wrap">{gitError}</pre>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share Task</DialogTitle>
          <DialogDescription>
            This plan will be packaged as a spec and shared with the recipient as a new task.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Recipient */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Recipient email</label>
            <Input
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              placeholder="user@example.com"
              autoFocus
              disabled={sending}
            />
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

          {/* Spec content — pre-filled from plan, editable */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <textarea
              value={specContent}
              onChange={(e) => setSpecContent(e.target.value)}
              rows={6}
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
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {success && !emailError && <p className="text-xs text-green-600 dark:text-green-400">Task shared successfully.</p>}
          {success && emailError && (
            <div className="space-y-1">
              <p className="text-xs text-green-600 dark:text-green-400">Task created successfully.</p>
              <p className="text-xs text-yellow-600 dark:text-yellow-400">Email could not be sent. A reminder has been added to your activity panel.</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!cloudLoginAvailable) {
                // Register callback to run after OAuth login completes (before page reload)
                (window as any).__postCloudLoginCallback = async () => {
                  await handleSend();
                  await new Promise(resolve => setTimeout(resolve, 1500));
                };
                void oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
                return;
              }
              void handleSend();
            }}
            disabled={!canSend}
          >
            {sending ? 'Sending...' : 'Share as Task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
