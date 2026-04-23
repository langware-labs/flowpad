/**
 * AskForAssistanceDialog - Send the current session to another user to ask for help.
 * Modelled on SendPlanNotificationDialog; uses spec_type='session' and pre-populates
 * content from the live session output.
 */

import { useEffect, useState } from 'react';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useContext } from '@sdk/react/hooks';
import { sendNotification } from '@sdk/entities/notifications';
import { createTaskBundle, DeliveryMode } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { oauthService, OAUTH_PROVIDERS } from '@sdk';
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

interface AskForAssistanceDialogProps {
  open: boolean;
  onClose: () => void;
  sessionTitle: string;
  sessionContent: string;
}

export function AskForAssistanceDialog({
  open,
  onClose,
  sessionTitle,
  sessionContent,
}: AskForAssistanceDialogProps) {
  const { cloudLoginAvailable } = useContext();
  const { localUser, updateName } = useLocalUser();
  const [mode, setMode] = useState<DeliveryMode>(DeliveryMode.EMAIL);
  const [recipientId, setRecipientId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [senderName, setSenderName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(sessionTitle);
      setContent(sessionContent);
      setRecipientId('');
      setMessage('Hi,\nI need some help with this session.\nPlease take a look and let me know.\nThanks!');
      setFiles([]);
      setError(null);
      setSuccess(false);
      setGitError(null);
      setEmailError(null);
      setEditingName(false);
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
    if (!recipientId.trim() || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendNotification({
        recipient_id: recipientId.trim(),
        spec_title: title.trim(),
        spec_content: content.trim(),
        spec_type: 'session',
        task_title: title.trim(),
        task_id: null,
        message: message.trim() || null,
        plan_id: null,
        project_path: null,
        sender_name: senderName.trim() || null,
      });
      if (result.git_error) {
        setGitError(result.git_error);
      } else if (result.email_error) {
        setSuccess(true);
        setEmailError(result.email_error);
        toast.warning('Request created, but the notification email could not be sent. Check your activity panel.');
        setTimeout(() => onClose(), 5000);
      } else {
        setSuccess(true);
        toast.success('Assistance request sent successfully!');
        setTimeout(() => onClose(), 1200);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send request.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createTaskBundle({
        spec_title: title.trim(),
        spec_content: content.trim(),
        task_title: title.trim(),
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

  const canSubmit = recipientId.trim().length > 0 && title.trim().length > 0 && !busy;

  return (
    <>
      <AlertDialog open={!!gitError} onOpenChange={(o) => { if (!o) { setGitError(null); onClose(); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Git Push Failed</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="mb-2">The request could not be pushed to the remote repository. Please fix the git issue below and try again.</p>
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
            <DialogTitle>Ask for Assistance</DialogTitle>
            <DialogDescription>
              Your current session will be packaged and shared as a task.
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
              <label className="text-xs font-medium text-muted-foreground">Recipient email</label>
              <Input
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value)}
                placeholder="user@example.com"
                autoFocus
                disabled={busy}
              />
            </div>

            {/* Session title */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Session title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                disabled={busy}
              />
            </div>

            {/* Session content */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Session content</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
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
            {success && !emailError && <p className="text-xs text-green-600 dark:text-green-400">Assistance request sent successfully.</p>}
            {success && emailError && (
              <div className="space-y-1">
                <p className="text-xs text-green-600 dark:text-green-400">Request created successfully.</p>
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
                    disabled={!title.trim() || busy}
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
                {busy ? 'Sending...' : 'Ask for Assistance'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
