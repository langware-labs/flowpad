import { connectionManager, gitOriginFromUrl, oauthService } from '@sdk';
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
import { hasGitHubRepoAccess } from '@src/utils/gitUtils';
import type { GitSetup } from '@src/hooks/use-desktops';
import { AlertTriangle, Github, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface NewDesktopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** Pre-fill the git URL (e.g. from a ?setup_git= deep link). */
  initialGitUrl?: string;
  /** Launch a desktop; when a repo is given, the hub sets it up in the box. */
  onLaunch: (opts: { name: string; gitSetup?: GitSetup }) => void;
}

/**
 * Start a desktop — name + an optional git repo. A public repo is set up
 * directly; a private/inaccessible repo gates on "connect GitHub to continue"
 * (the existing device-auth), re-validates, then launches. On submit we hand
 * off to `useDesktops().launch`, which runs the hub's setup-git (clone → copy
 * into the box → materialize).
 */
export function NewDesktopDialog({ open, onOpenChange, defaultName, initialGitUrl, onLaunch }: NewDesktopDialogProps) {
  const { t } = useLingui();
  const [name, setName] = useState(defaultName);
  const [url, setUrl] = useState(initialGitUrl ?? '');
  const [checking, setChecking] = useState(false);
  const [needsGithub, setNeedsGithub] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  // Reset on OPEN only. `defaultName` changes whenever the desktop list refetches
  // (it's derived from it), so depending on it here would wipe what the user has
  // already typed mid-dialog.
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setUrl(initialGitUrl ?? '');
    setNeedsGithub(false);
    setConnecting(false);
    setError('');
    setChecking(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const finish = useCallback(
    (gitSetup?: GitSetup) => {
      onOpenChange(false);
      onLaunch({ name: name.trim() || defaultName, gitSetup });
    },
    [onLaunch, name, defaultName, onOpenChange],
  );

  // Validate the repo, then either launch (accessible) or reveal the connect
  // gate (private/inaccessible). Returns true when it launched.
  const validateAndMaybeLaunch = useCallback(async (): Promise<boolean> => {
    const gitOrigin = gitOriginFromUrl(url.trim());
    if (!gitOrigin) {
      setError(t`Enter a valid GitHub repository URL.`);
      return false;
    }
    setError('');
    setChecking(true);
    try {
      const access = await hasGitHubRepoAccess(url.trim());
      if (access?.hasAccess) {
        finish({ gitOrigin, name: name.trim() || defaultName });
        return true;
      }
      setNeedsGithub(true);
      return false;
    } finally {
      setChecking(false);
    }
  }, [url, name, defaultName, finish, t]);

  const handleSubmit = useCallback(() => {
    if (!url.trim()) {
      finish(); // name-only → plain desktop
      return;
    }
    void validateAndMaybeLaunch();
  }, [url, finish, validateAndMaybeLaunch]);

  // Connect GitHub, then re-validate on the device-flow success broadcast.
  const handleConnectGithub = useCallback(() => {
    setConnecting(true);
    setError('');
    const handler = (msg: { auth_method?: string; status?: string }) => {
      if (msg.auth_method !== 'github') return;
      connectionManager.off('on_llm_config_msg', handler);
      if (msg.status === 'success') {
        void validateAndMaybeLaunch().then((launched) => {
          if (!launched) setError(t`Connected, but still no access to this repo.`);
          setConnecting(false);
        });
      } else {
        setConnecting(false);
        setError(t`GitHub connection failed.`);
      }
    };
    connectionManager.on('on_llm_config_msg', handler);
    void oauthService.connect('github').catch((e: unknown) => {
      connectionManager.off('on_llm_config_msg', handler);
      setConnecting(false);
      // Prefer the backend's ApiFailResponse message over axios's generic
      // "Request failed with status code 500" (same unwrap NewProjectFromGitDialog does).
      const ax = e as { response?: { data?: { message?: string } }; message?: string };
      setError(ax.response?.data?.message ?? ax.message ?? t`Couldn't start GitHub connection.`);
    });
  }, [validateAndMaybeLaunch, t]);

  const busy = checking || connecting;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle><Trans>New desktop</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Name it, and optionally set it up from a git repo.</Trans>
          </DialogDescription>
        </DialogHeader>

        <label className="mb-1 block text-xs font-medium text-muted-foreground"><Trans>Name</Trans></label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName}
          className="mb-3 text-sm"
          autoFocus
        />

        <label className="mb-1 block text-xs font-medium text-muted-foreground"><Trans>Git repo (optional)</Trans></label>
        <Input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setNeedsGithub(false); setError(''); }}
          placeholder={t`https://github.com/owner/repo`}
          className="font-mono text-xs"
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) handleSubmit(); }}
        />

        {needsGithub && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <Trans>Repo is not public — connect GitHub to continue.</Trans>
            </span>
            <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={handleConnectGithub} disabled={connecting}>
              {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Github className="h-3 w-3" />}
              <span className="ml-1.5"><Trans>Connect</Trans></span>
            </Button>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {checking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            <Trans>Launch</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
