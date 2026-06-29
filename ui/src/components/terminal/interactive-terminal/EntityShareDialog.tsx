/**
 * EntityShareDialog — link + bundle export for any entity, addressed by TypeId.
 *
 * Two modes:
 *  - LINK:  copy a deep-link URL to the entity
 *  - BUNDLE: download a portable .flowmsg zip
 *
 * The conversation/email share moved to the contact-first
 * ``ShareToConversationDialog`` (so a re-share threads into the existing
 * conversation instead of minting a new one + invite). This dialog is the
 * "export / link" half. All entity-specific behavior lives in ``useEntityShare``.
 */

import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { TypeId } from '@sdk';
import { useEntityShare } from '@src/hooks/use-entity-share';
import { notify } from '@src/notifications';
import { Download, Link2, Copy, Check } from 'lucide-react';
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

type ShareMode = 'link' | 'bundle';

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
  const { t } = useLingui();
  const entityShare = useEntityShare(typeId);
  const isProcess = entityShare.isAgenticProcess;
  const entityType = isProcess ? 'session' : 'entity';

  const [mode, setMode] = useState<ShareMode>(allowCopyLink ? 'link' : 'bundle');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const initialTitle = useMemo(() => defaultTitle ?? '', [defaultTitle]);

  useEffect(() => {
    if (open) {
      setMode(allowCopyLink ? 'link' : 'bundle');
      setTitle(initialTitle);
      setMessage('');
      setError(null);
      setBusy(false);
      setShareUrl(null);
      setLinkCopied(false);
    }
  }, [open, initialTitle, allowCopyLink]);

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleCopyLink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await entityShare.copyLink();
      setShareUrl(url);
      setLinkCopied(true);
      notify.success({ title: t`Link copied to clipboard` });
    } catch (err: unknown) {
      const fallbackMsg = err instanceof Error ? err.message : 'Could not copy link.';
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
      notify.success({ title: t`Bundle ready — download started.` });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task bundle.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmitBundle = title.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>Export / link</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Copy a link or download this {entityType} as a portable bundle.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {allowCopyLink && (
            <div className="flex rounded-md border border-input p-0.5">
              <ModeButton
                active={mode === 'link'}
                onClick={() => setMode('link')}
                disabled={busy}
                icon={<Link2 className="h-3.5 w-3.5" />}
                label={t`Copy link`}
              />
              <ModeButton
                active={mode === 'bundle'}
                onClick={() => setMode('bundle')}
                disabled={busy}
                icon={<Download className="h-3.5 w-3.5" />}
                label={t`Download bundle`}
              />
            </div>
          )}

          {mode === 'link' && allowCopyLink && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <Trans>Anyone with access can open this {entityType} directly via the link below.</Trans>
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
                {linkCopied ? t`Copied` : t`Copy link`}
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}

          {mode === 'bundle' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <Trans>Package this share into a portable <code>.flowmsg</code> file that recipients can import.</Trans>
              </p>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground"><Trans>Title</Trans></label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t`Title`}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground"><Trans>Message (optional)</Trans></label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t`Add a personal note...`}
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
                <Trans>Download .flowmsg</Trans>
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}
        </div>

        <DialogFooter>
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={handleClose} disabled={busy}>
              <Trans>Close</Trans>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
