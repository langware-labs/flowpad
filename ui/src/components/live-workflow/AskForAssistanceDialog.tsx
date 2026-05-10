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
import { AgenticProcess, ConversationParticipant, dataManager, oauthService, OAUTH_PROVIDERS, TypeId } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { loadOptionalTranscript } from '@src/components/conversation/transcript-attachment';
import { generateIssueDocument } from '@src/components/conversation/generate-issue-doc';
import { toast } from 'sonner';
import { Mail, Download, Github, Pencil, Loader2 } from 'lucide-react';
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
  /** Active AgenticProcess id — stamped onto the sender's task as my_process_id, and resolved internally to a session_id when the transcript checkbox is on. */
  processId?: string;
  /** Project / cwd of the active session — used by ClaudeSessionRecord.discover for O(1) lookup. */
  projectPath?: string;
}

export function AskForAssistanceDialog({
  open,
  onClose,
  sessionTitle,
  sessionContent,
  processId,
  projectPath,
}: AskForAssistanceDialogProps) {
  const { cloudLoginAvailable } = useContext();
  const { localUser, updateName } = useLocalUser();
  const [mode, setMode] = useState<DeliveryMode>(DeliveryMode.EMAIL);
  const [recipients, setRecipients] = useState<ConversationParticipant[]>([]);
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
  const [attachTranscript, setAttachTranscript] = useState(true);
  /** Confirmation dialog shown when the user unchecks "Attach transcript". */
  const [showUncheckWarning, setShowUncheckWarning] = useState(false);
  /** True while a headless Claude run is generating issue.md in the background. */
  const [generatingDoc, setGeneratingDoc] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(sessionTitle);
      setContent(sessionContent);
      setRecipients([]);
      setMessage('Hi,\nI need some help with this session.\nPlease take a look and let me know.\nThanks!');
      setFiles([]);
      setError(null);
      setSuccess(false);
      setGitError(null);
      setEmailError(null);
      setEditingName(false);
      setAttachTranscript(true);
      setShowUncheckWarning(false);
      setGeneratingDoc(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (localUser?.name) setSenderName(localUser.name);
  }, [localUser?.name]);

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  /**
   * Checkbox change: unchecking opens the warning dialog instead of taking
   * effect immediately, so the user has to consciously confirm sending without
   * context. Re-checking proceeds without confirmation.
   */
  const handleAttachTranscriptChange = (next: boolean) => {
    if (next) {
      setAttachTranscript(true);
      return;
    }
    if (busy || generatingDoc) return;
    setShowUncheckWarning(true);
  };

  /** Warning option 1: spawn a headless Claude that summarizes the issue. */
  const handleGenerateDocument = async () => {
    if (!processId || generatingDoc) return;
    setGeneratingDoc(true);
    try {
      const proc = await dataManager.getByTypeId<AgenticProcess>(
        new TypeId(AgenticProcess.type, processId),
      );
      if (!proc) throw new Error('Could not load active process');
      const docFile = await generateIssueDocument({ proc, projectPath });
      setFiles((prev) => {
        const filtered = prev.filter((f) => f.name !== docFile.name);
        return [...filtered, docFile];
      });
      setAttachTranscript(false);
      setShowUncheckWarning(false);
      toast.success('Generated issue.md from your session and attached it.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate document.';
      toast.error(`Could not generate document: ${msg}`);
    } finally {
      setGeneratingDoc(false);
    }
  };

  /** Warning option 2: keep the transcript attached, dismiss the dialog. */
  const handleKeepTranscript = () => {
    setAttachTranscript(true);
    setShowUncheckWarning(false);
  };

  /** Warning option 3: proceed without context. Just dismiss; user must still click Send. */
  const handleSendAnyway = () => {
    setAttachTranscript(false);
    setShowUncheckWarning(false);
  };

  const handleEmail = async () => {
    const recipientId = recipients[0]?.email?.trim() ?? '';
    if (!recipientId || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Resolve the AgenticProcess so loadOptionalTranscript can walk the fork
      // chain (cli_config.fork_session_id) when this process has no jsonl yet.
      const proc = processId
        ? await dataManager.getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, processId)).catch(() => null)
        : null;
      const transcriptResult = await loadOptionalTranscript(files, {
        attach: attachTranscript,
        proc,
        projectPath,
      });
      if (attachTranscript && !transcriptResult.attached) {
        toast.warning(
          `Transcript not attached: ${transcriptResult.failureReason ?? 'unknown reason'}`,
        );
      }
      const filesWithTranscript = transcriptResult.files;

      // Scenario C: pre-fork the live session into an invisible AgenticProcess
      // so the recipient's Approve & Execute reuses the existing fork (which
      // inherits all the conversational context the sender built before
      // sharing) instead of spawning a fresh process. Best-effort — fork
      // failure shouldn't block the share.
      let forkedProcessId: string | null = null;
      if (proc) {
        try {
          const forked = await proc.fork(false);
          forkedProcessId = forked.id ?? null;
        } catch (forkErr) {
          console.warn('[AskForAssistanceDialog] pre-fork failed (non-fatal):', forkErr);
        }
      }

      const result = await sendNotification({
        recipient_id: recipientId,
        spec_title: title.trim(),
        spec_content: content.trim(),
        spec_type: 'session',
        task_title: title.trim(),
        task_id: null,
        message: message.trim() || null,
        plan_id: null,
        project_path: projectPath ?? null,
        sender_name: senderName.trim() || null,
        files: filesWithTranscript.length > 0 ? filesWithTranscript : undefined,
        // Stamp the sender's AgenticProcess id so their per-message "Open Claude
        // Code" chip is wired immediately, no Start step required.
        sender_process_id: processId ?? null,
        forked_process_id: forkedProcessId,
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

  const canSubmit = recipients.length > 0 && title.trim().length > 0 && !busy;

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

      <AlertDialog
        open={showUncheckWarning}
        onOpenChange={(o) => {
          if (generatingDoc) return;
          if (!o) handleKeepTranscript();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send without context?</AlertDialogTitle>
            <AlertDialogDescription>
              Without your Claude Code transcript, the recipient may not have enough information to help.
              Pick one:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch sm:space-x-0">
            <Button
              type="button"
              onClick={handleGenerateDocument}
              disabled={generatingDoc || !processId}
              className="w-full"
            >
              {generatingDoc ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating issue.md…</>
              ) : (
                'Generate a document describing the issue'
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleKeepTranscript}
              disabled={generatingDoc}
              className="w-full"
            >
              Attach the transcript
            </Button>
            <button
              type="button"
              onClick={handleSendAnyway}
              disabled={generatingDoc}
              className="w-full pt-1 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:opacity-50"
            >
              Send anyway
            </button>
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
              <label className="text-xs font-medium text-muted-foreground">Recipient</label>
              <ContactPicker
                value={recipients}
                onChange={setRecipients}
                excludeUserId={localUser?.id}
                max={1}
                disabled={busy}
                enabled={open}
                placeholder="Search contacts or type an email"
                testId="ask-assistance-recipient-input"
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
              {processId && (
                <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={attachTranscript}
                    onChange={(e) => handleAttachTranscriptChange(e.target.checked)}
                    disabled={busy || generatingDoc}
                    className="h-3.5 w-3.5 rounded border-input"
                  />
                  Attach my Claude Code transcript
                </label>
              )}
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
                {busy ? 'Sending...' : 'Send'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
