/**
 * SendPlanNotificationDialog - Share a plan as a task.
 * Supports two delivery modes:
 *   Share via Email — sends via Flowpad Hub (requires recipient)
 *   Share via Repo  — coming soon (disabled)
 * A download icon in the top-left lets the user save a .flowmsg file locally.
 */

import { useEffect, useState } from 'react';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { useContext } from '@sdk/react/hooks';
import { sendNotification } from '@sdk/entities/notifications';
import { createTaskBundle, DeliveryMode } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { oauthService, OAUTH_PROVIDERS } from '@sdk';
import { toast } from 'sonner';
import { Mail, Download, Github } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
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
  const [mode, setMode] = useState<DeliveryMode>(DeliveryMode.EMAIL);
  const [recipientId, setRecipientId] = useState('');
  const [specTitle, setSpecTitle] = useState('');
  const [specContent, setSpecContent] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSpecTitle(extractTitle(planContent, planFilePath));
      setSpecContent(planContent);
      setRecipientId('');
      setMessage('Hi,\nGot a new task for you.\nLMK if you have any questions.\nGood luck!');
      setFiles([]);
      setError(null);
      setSuccess(false);
      setGitError(null);
      setEmailError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleEmail = async () => {
    if (!recipientId.trim() || !specTitle.trim() || busy) return;
    setBusy(true);
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

  const canSubmit = recipientId.trim().length > 0 && specTitle.trim().length > 0 && !busy;

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

            {/* Recipient */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Recipient email</label>
              <Input
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value)}
                placeholder="user@example.com"
                autoFocus
                disabled={busy}
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
            {success && !emailError && <p className="text-xs text-green-600 dark:text-green-400">Task shared successfully.</p>}
            {success && emailError && (
              <div className="space-y-1">
                <p className="text-xs text-green-600 dark:text-green-400">Task created successfully.</p>
                <p className="text-xs text-yellow-600 dark:text-yellow-400">Email could not be sent. A reminder has been added to your activity panel.</p>
              </div>
            )}
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
    </>
  );
}
