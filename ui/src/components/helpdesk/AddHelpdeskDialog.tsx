import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { type AdoptHelpdeskResult, type Project } from '@sdk';
import { GitRepoPicker, type GitTarget } from '@src/components/git/GitRepoPicker';
import { DependencyKindChips } from '@src/components/assets/dependency-sources';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import type { DependencyKind } from '@src/hooks/use-project-dependencies';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { AlertTriangle, LifeBuoy, Loader2 } from 'lucide-react';

/**
 * Adopt a help desk: attach a vendor's desk repo to this project.
 *
 * **The URL field is the primary input, not the repo picker.** A vendor's desk
 * is somebody else's repository — it is not in the list of repos your token can
 * reach — so browsing is the secondary path here, the reverse of the clone
 * dialog. Branch selection works for a pasted URL too, because the backend
 * reads public branches anonymously; that matters because a desk on a
 * non-default branch is the normal case, and the wizard path's silent "clone
 * whatever `main` is" is the bug this surface exists to fix.
 *
 * Nothing here needs a hub, a cloud login, or a GitHub connection for a public
 * desk. GitHub only buys you the browse path and private repos.
 */
export interface AddHelpdeskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  /** Ran after a successful adopt — the host passes its project refetch. The
   *  action returns a summary, not the project, so `include_dirs` does not
   *  refresh on its own and the Dependencies rows would lag. */
  onAdded?: () => Promise<unknown> | void;
}

export function AddHelpdeskDialog({ open, onOpenChange, project, onAdded }: AddHelpdeskDialogProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState<string | null>(null);
  const [kind, setKind] = useState<DependencyKind>('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdoptHelpdeskResult | null>(null);
  const [removing, setRemoving] = useState(false);
  /** True while the shared picker's branch list owns the body. */
  const [inBranchPicker, setInBranchPicker] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUrl('');
    setBranch(null);
    setKind('local');
    setBusy(false);
    setError(null);
    setResult(null);
    setRemoving(false);
    setInBranchPicker(false);
  }, [open]);

  const handlePick = useCallback((target: GitTarget | null) => {
    setUrl(target?.mode === 'existing' ? target.url : '');
    setBranch(target?.mode === 'existing' ? (target.branch ?? null) : null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await project.adoptHelpdeskFromGit(target, branch ?? '', kind === 'optional');
      setResult(res);
      // Every outcome added the dependency — `no_manifest` included — so the
      // project's context rows are stale in all of them.
      await onAdded?.();
    } catch (err) {
      // The backend's own messages name the real failure — a 409 naming both
      // branches, an unreachable remote, a bad URL — far better than we could.
      setError(errorMessage(err, t`Could not add the help desk.`));
    } finally {
      setBusy(false);
    }
  }, [url, branch, kind, busy, project, onAdded, t]);

  const openPortal = useCallback(() => {
    const portalId = result?.portal_project_id;
    if (!portalId) return;
    onOpenChange(false);
    // URL-first: the only thing this handler does. No context priming — the
    // loader is the single writer.
    navigation.openDock(DockPointer.forHelpdesk(portalId));
  }, [result, navigation, onOpenChange]);

  const removeFolder = useCallback(async () => {
    if (!result?.dependency || removing) return;
    setRemoving(true);
    try {
      await project.removeDependency(result.dependency);
      await onAdded?.();
      onOpenChange(false);
      notify.success({ title: t`Package removed` });
    } catch (err) {
      notify.error({
        title: t`Could not remove the package`,
        message: errorMessage(err, t`Unknown error`),
      });
    } finally {
      setRemoving(false);
    }
  }, [result, removing, project, onAdded, onOpenChange, t]);

  // Block ESC / outside-click while the attach is in flight: it clones and
  // indexes, so unmounting mid-call drops the surface that reports what happened.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && busy) return;
      onOpenChange(next);
    },
    [busy, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="add-helpdesk-dialog"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onPointerDownOutside={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LifeBuoy className="h-4 w-4" />
            <Trans>Add help desk</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Point this project at a support desk published as a git repository.</Trans>
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <HelpdeskResult
            result={result}
            removing={removing}
            onOpenPortal={openPortal}
            onRemove={() => void removeFolder()}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {/* The URL is primary here: a vendor's desk is somebody else's repo. */}
            <GitRepoPicker
              modes={['existing']}
              onChange={handlePick}
              onStepChange={setInBranchPicker}
              onEnter={() => !busy && void submit()}
              urlPlaceholder={t`https://github.com/owner/help-desk`}
              enabled={open}
              testIdPrefix="add-helpdesk"
            />

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                <Trans>Package</Trans>
              </span>
              <DependencyKindChips kind={kind} onChange={setKind} />
            </div>

            {error && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                data-testid="add-helpdesk-error"
              >
                {error}
              </div>
            )}

            {busy && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <Trans>Fetching the desk and indexing it…</Trans>
              </div>
            )}
          </div>
        )}

        {!result && !inBranchPicker && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={() => void submit()} disabled={!url.trim() || busy} data-testid="add-helpdesk-submit">
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              <Trans>Add help desk</Trans>
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What actually happened, in the user's terms.
 *
 * Keyed on the backend's closed `outcome` rather than on truthiness of
 * `helpdesk_id`: three of the six outcomes DID find a desk and still must not
 * read as success, and a boolean cannot carry that.
 */
function HelpdeskResult({
  result,
  removing,
  onOpenPortal,
  onRemove,
}: {
  result: AdoptHelpdeskResult;
  removing: boolean;
  onOpenPortal: () => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const name = result.display_name;
  const good = result.outcome === 'adopted' || result.outcome === 'already_adopted';

  return (
    <div className="flex flex-col gap-3" data-testid={`add-helpdesk-result-${result.outcome}`}>
      <div
        className={`flex items-start gap-3 rounded-md border px-3 py-3 ${
          good ? 'border-border bg-card/40' : 'border-amber-500/40 bg-amber-500/10'
        }`}
      >
        {good ? (
          <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          {good && (
            <>
              <span className="text-sm font-medium">{name}</span>
              {result.welcome_message && (
                <span className="text-xs text-muted-foreground">{result.welcome_message}</span>
              )}
              <span className="text-xs text-muted-foreground">
                {result.outcome === 'already_adopted' ? (
                  <Trans>Already attached to this project.</Trans>
                ) : (
                  <Trans>Added to this project.</Trans>
                )}
              </span>
            </>
          )}

          {result.outcome === 'shadowed' && (
            <>
              <span className="text-sm font-medium">
                <Trans>{name} was added, but another desk answers first</Trans>
              </span>
              <span className="text-xs text-muted-foreground">
                {/* Never dressed up as success: the user would otherwise believe
                    their requests now reach this vendor, and they do not. */}
                <Trans>
                  Support requests from this project keep going to{' '}
                  <span className="font-medium">{result.shadowed_by?.display_name ?? t`the existing desk`}</span>.
                  Remove that one first if you want this desk to answer.
                </Trans>
              </span>
            </>
          )}

          {result.outcome === 'no_manifest' && (
            <>
              <span className="text-sm font-medium">
                <Trans>No help desk in this repository</Trans>
              </span>
              <span className="text-xs text-muted-foreground">
                <Trans>
                  It was added as an ordinary package instead, so agents can still read it. Remove it if that is not
                  what you wanted.
                </Trans>
              </span>
            </>
          )}

          {result.outcome === 'invalid_desk_project_id' && (
            <>
              <span className="text-sm font-medium">
                <Trans>{name} names no support queue</Trans>
              </span>
              <span className="text-xs text-muted-foreground">
                <Trans>
                  Its manifest has no usable desk id, so requests would go to the default desk rather than to this one.
                  The repository's publisher needs to fix it.
                </Trans>
              </span>
            </>
          )}

          {result.outcome === 'no_portal_project' && (
            <>
              <span className="text-sm font-medium">
                <Trans>{name} was added, but its guides cannot be opened</Trans>
              </span>
              <span className="text-xs text-muted-foreground">
                <Trans>Support requests will still reach it.</Trans>
              </span>
            </>
          )}

          <span className="truncate font-mono text-[11px] text-muted-foreground" title={result.path}>
            {result.path}
          </span>
        </div>
      </div>

      <DialogFooter>
        {result.outcome === 'no_manifest' && (
          <Button variant="outline" onClick={onRemove} disabled={removing} data-testid="add-helpdesk-remove">
            {removing && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Remove package</Trans>
          </Button>
        )}
        {result.portal_project_id && (
          <Button onClick={onOpenPortal} data-testid="add-helpdesk-open">
            <Trans>Open help desk</Trans>
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

export default AddHelpdeskDialog;
