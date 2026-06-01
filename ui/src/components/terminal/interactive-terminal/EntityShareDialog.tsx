/**
 * EntityShareDialog — generic share dialog for any entity, addressed by TypeId.
 *
 * Three modes:
 *  - EMAIL: send-to-recipient + note (the historical "Ask for Assistance" flow)
 *  - LINK:  copy a deep-link URL to the entity
 *  - BUNDLE: download a portable .flowmsg zip
 *
 * All entity-specific behavior (lazy fork for AgenticProcess, transcript-attach,
 * URL resolution) lives in `useEntityShare`. This dialog is presentation only.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileAttachmentPicker } from '@src/components/conversation/FileAttachmentPicker';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useContext } from '@sdk/react/hooks';
import { AgenticProcess, ConversationParticipant, dataManager, oauthService, OAUTH_PROVIDERS, TypeId } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { generateIssueDocument } from '@src/components/conversation/generate-issue-doc';
import { useEntityShare } from '@src/hooks/use-entity-share';
import { notify } from '@src/notifications';
import { Mail, Download, Link2, Copy, Check, Pencil, Loader2 } from 'lucide-react';
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

type ShareMode = 'email' | 'link' | 'bundle';

interface EntityShareDialogProps {
  open: boolean;
  onClose: () => void;
  /** Canonical entity ref. */
  typeId: TypeId;
  /** Optional override; defaults to the entity's resolved display name. */
  defaultTitle?: string;
  /** Show the "Copy link" mode. Defaults to false — opt in per surface. */
  allowCopyLink?: boolean;
}

export function EntityShareDialog({ open, onClose, typeId, defaultTitle, allowCopyLink = false }: EntityShareDialogProps) {
  const { cloudLoginAvailable } = useContext();
  const { localUser, updateName } = useLocalUser();
  const entityShare = useEntityShare(typeId);
  const isProcess = entityShare.shouldForkBeforeSend;

  const [mode, setMode] = useState<ShareMode>('email');
  const [recipients, setRecipients] = useState<ConversationParticipant[]>([]);
  const [title, setTitle] = useState('');
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
  const [showUncheckWarning, setShowUncheckWarning] = useState(false);
  const [generatingDoc, setGeneratingDoc] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const defaults = useMemo(() => entityShare.getDefaults(), [entityShare]);
  const initialTitle = defaultTitle ?? defaults.title;

  useEffect(() => {
    if (open) {
      setMode('email');
      setTitle(initialTitle);
      setRecipients([]);
      setMessage(defaults.message);
      setFiles([]);
      setError(null);
      setSuccess(false);
      setGitError(null);
      setEmailError(null);
      setEditingName(false);
      setAttachTranscript(true);
      setShowUncheckWarning(false);
      setGeneratingDoc(false);
      setShareUrl(null);
      setLinkCopied(false);
    }
  }, [open, initialTitle, defaults.message]);

  useEffect(() => {
    if (localUser?.name) setSenderName(localUser.name);
  }, [localUser?.name]);

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleAttachTranscriptChange = (next: boolean) => {
    if (next) {
      setAttachTranscript(true);
      return;
    }
    if (busy || generatingDoc) return;
    setShowUncheckWarning(true);
  };

  const handleGenerateDocument = async () => {
    if (!isProcess || generatingDoc) return;
    setGeneratingDoc(true);
    try {
      const proc = await dataManager.getByTypeId<AgenticProcess>(
        new TypeId(AgenticProcess.type, typeId.id),
      );
      if (!proc) throw new Error('Could not load active process');
      const projectPath = (proc as { workdir?: string }).workdir;
      const docFile = await generateIssueDocument({ proc, projectPath });
      setFiles((prev) => {
        const filtered = prev.filter((f) => f.name !== docFile.name);
        return [...filtered, docFile];
      });
      setAttachTranscript(false);
      setShowUncheckWarning(false);
      notify.success({ title: 'Generated issue.md from your session and attached it.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate document.';
      notify.error({ title: `Could not generate document: ${msg}` });
    } finally {
      setGeneratingDoc(false);
    }
  };

  const handleKeepTranscript = () => {
    setAttachTranscript(true);
    setShowUncheckWarning(false);
  };

  const handleSendAnyway = () => {
    setAttachTranscript(false);
    setShowUncheckWarning(false);
  };

  const handleSend = async () => {
    if (!recipients[0]?.email?.trim() || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await entityShare.share({
        recipients,
        title,
        message,
        files,
        attachTranscript: isProcess ? attachTranscript : false,
        senderName,
      });
      if (result.gitError) {
        setGitError(result.gitError);
      } else if (result.emailError) {
        setSuccess(true);
        setEmailError(result.emailError);
        notify.warning({ title: 'Request created, but the notification email could not be sent. Check your activity panel.' });
        setTimeout(() => onClose(), 5000);
      } else {
        setSuccess(true);
        notify.success({ title: 'Assistance request sent successfully!' });
        setTimeout(() => onClose(), 1200);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send request.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyLink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await entityShare.copyLink();
      setShareUrl(url);
      setLinkCopied(true);
      notify.success({ title: 'Link copied to clipboard' });
    } catch (err: unknown) {
      // Try once more to surface the URL even if clipboard failed.
      const fallbackMsg =
        err instanceof Error ? err.message : 'Could not copy link.';
      setError(fallbackMsg);
      notify.error({ title: fallbackMsg });
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadBundle = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await entityShare.exportBundle({ title, message });
      const a = document.createElement('a');
      a.href = result.downloadUrl;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      notify.success({ title: 'Bundle ready — download started.' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task bundle.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmitEmail = recipients.length > 0 && title.trim().length > 0 && !busy;
  const canSubmitBundle = title.trim().length > 0 && !busy;

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
              disabled={generatingDoc || !isProcess}
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
            <DialogTitle>Share</DialogTitle>
            <DialogDescription>
              Send to a teammate, copy a link, or download as a portable bundle.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Mode toggle */}
            <div className="flex rounded-md border border-input p-0.5">
              <ModeButton
                active={mode === 'email'}
                onClick={() => setMode('email')}
                disabled={busy}
                icon={<Mail className="h-3.5 w-3.5" />}
                label="Send to recipient"
              />
              {allowCopyLink && (
                <ModeButton
                  active={mode === 'link'}
                  onClick={() => setMode('link')}
                  disabled={busy}
                  icon={<Link2 className="h-3.5 w-3.5" />}
                  label="Copy link"
                />
              )}
              <ModeButton
                active={mode === 'bundle'}
                onClick={() => setMode('bundle')}
                disabled={busy}
                icon={<Download className="h-3.5 w-3.5" />}
                label="Download bundle"
              />
            </div>

            {mode === 'email' && (
              <>
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

                {/* Title */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Title</label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Title"
                    disabled={busy}
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
                  {isProcess && (
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
              </>
            )}

            {mode === 'link' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Anyone with access can open this {isProcess ? 'session' : 'entity'} directly via the link below.
                </p>
                {shareUrl && (
                  <div className="rounded-md border border-input bg-muted px-3 py-2 text-xs text-foreground break-all">
                    {shareUrl}
                  </div>
                )}
                <Button
                  type="button"
                  onClick={() => void handleCopyLink()}
                  disabled={busy || !entityShare.canShare}
                  className="w-full gap-2"
                >
                  {linkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {linkCopied ? 'Copied' : 'Copy link'}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
            )}

            {mode === 'bundle' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Package this share into a portable <code>.flowmsg</code> file that recipients can import.
                </p>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Title</label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Title"
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
                <Button
                  type="button"
                  onClick={() => void handleDownloadBundle()}
                  disabled={!canSubmitBundle}
                  className="w-full gap-2"
                >
                  <Download className="h-4 w-4" />
                  Download .flowmsg
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
            )}
          </div>

          <DialogFooter>
            <div className="flex w-full justify-end gap-2">
              <Button variant="outline" onClick={handleClose} disabled={busy}>
                {mode === 'email' ? 'Cancel' : 'Close'}
              </Button>
              {mode === 'email' && (
                <Button
                  onClick={() => {
                    if (!cloudLoginAvailable) {
                      (window as any).__postCloudLoginCallback = async () => {
                        await handleSend();
                        await new Promise(resolve => setTimeout(resolve, 1500));
                      };
                      void oauthService.connect(OAUTH_PROVIDERS.FLOWPAD_CLOUD);
                      return;
                    }
                    void handleSend();
                  }}
                  disabled={!canSubmitEmail}
                >
                  {busy ? 'Sending...' : 'Send'}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ModeButton({
  active,
  onClick,
  disabled,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-1 items-center justify-center gap-2 rounded py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
