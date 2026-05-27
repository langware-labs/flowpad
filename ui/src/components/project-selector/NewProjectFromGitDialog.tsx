import { ActionInfo, connectionManager, dataContext, dataManager, oauthService, type RepoSummary } from '@sdk';
import { BranchPicker } from '@src/components/git/BranchPicker';
import { InvitationsStrip } from '@src/components/git/InvitationsStrip';
import { RepoPicker } from '@src/components/git/RepoPicker';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { CheckCircle2, GitBranch, Github, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export interface NewProjectFromGitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Async callback invoked on submit.
   *
   * `acceptSuggested` is set when the user has accepted a name suggestion
   * after a previous collision — pass it through as the target name override
   * so the backend uses it verbatim.
   *
   * `branch` is set when the user picked one via the BranchPicker (or the
   * paste-URL field accepts a #branch suffix in a future iteration).
   *
   * Resolve with `{ ok: false, suggestedName }` to keep the dialog open and
   * render the "use `<suggested>`?" accept banner. Resolve with `{ ok: true }`
   * to let the dialog close. Throw to surface an error toast and stay open.
   */
  onCreate: (
    url: string,
    acceptSuggested?: string,
    branch?: string,
  ) => Promise<{ ok: true } | { ok: false; suggestedName: string; attemptedName: string }>;
}

async function fetchGithubStatus(): Promise<boolean | null> {
  // Returns:
  //   true  → connected
  //   false → genuinely missing
  //   null  → couldn't determine (bootstrap not ready / network error)
  // The caller treats null as "show the disconnected banner but don't be loud".
  const userTypeId = dataContext.userTypeId;
  if (!userTypeId?.id) {
    // Bootstrap hasn't populated the user yet — skip the call rather than fire
    // a malformed /api/v1/graph/user/oauth/github/status (no id), which would
    // 404 silently and falsely report "not connected" for connected users.
    return null;
  }
  try {
    const info = new ActionInfo('oauth', userTypeId.type, userTypeId.id, 'GET');
    info.subpath = 'github/status';
    const res = await dataManager.callAction<unknown, { has_token?: boolean; status?: string }>(info);
    return Boolean(res?.has_token);
  } catch {
    return null;
  }
}

export function NewProjectFromGitDialog({ open, onOpenChange, onCreate }: NewProjectFromGitDialogProps) {
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ suggestedName: string; attemptedName: string } | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean>(false);
  // Picker state: null = step 1 (repo table). Non-null = step 2 (branches for this repo).
  const [pickedRepo, setPickedRepo] = useState<RepoSummary | null>(null);

  // Re-poll on every open AND whenever userTypeId becomes available — handles
  // the bootstrap race where the dialog mounts before dataContext.userTypeId is
  // populated (fetchGithubStatus returns null in that case).
  useEffect(() => {
    if (!open) return;
    setUrl('');
    setBranch(null);
    setPickedRepo(null);
    setIsSubmitting(false);
    setSuggestion(null);

    let cancelled = false;
    const poll = async () => {
      const result = await fetchGithubStatus();
      if (cancelled) return;
      if (result === null) {
        // Couldn't determine — retry briefly. The userTypeId usually arrives
        // within the first second of bootstrap.
        setTimeout(() => {
          if (!cancelled) void poll();
        }, 500);
        return;
      }
      setGithubConnected(result);
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Refresh status on a successful GitHub connect broadcast.
  useEffect(() => {
    if (!open) return;
    const handler = (msg: { auth_method?: string; status?: string }) => {
      if (msg.auth_method === 'github' && msg.status === 'success') {
        void fetchGithubStatus().then((r) => {
          if (r !== null) setGithubConnected(r);
        });
      }
    };
    connectionManager.on('on_llm_config_msg', handler);
    return () => {
      connectionManager.off('on_llm_config_msg', handler);
    };
  }, [open]);

  const handleConnectGithub = useCallback(async () => {
    try {
      await oauthService.connect('github');
    } catch (err) {
      // Prefer the backend's ApiFailResponse message over axios's generic
      // "Request failed with status code 500".
      const ax = err as { response?: { data?: { message?: string } }; message?: string };
      const title = ax.response?.data?.message ?? ax.message ?? 'Failed to start GitHub connection';
      toast({ title, variant: 'destructive' });
    }
  }, [toast]);

  const canSubmit = !!url.trim() && !isSubmitting;

  const submit = useCallback(
    async (acceptSuggested?: string) => {
      if (isSubmitting || !url.trim()) return;
      setIsSubmitting(true);
      try {
        const res = await onCreate(url.trim(), acceptSuggested, branch ?? undefined);
        if (res.ok) {
          onOpenChange(false);
        } else {
          setSuggestion({ suggestedName: res.suggestedName, attemptedName: res.attemptedName });
        }
      } catch (err) {
        toast({
          title: err instanceof Error ? err.message : 'Failed to clone repository',
          variant: 'destructive',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, url, branch, onCreate, onOpenChange, toast],
  );

  const handlePickRepo = useCallback((repo: RepoSummary) => {
    setPickedRepo(repo);
    setBranch(null); // require explicit branch choice after picking a different repo
    // Pre-fill the URL field so the user can see what they picked even before
    // choosing a branch; selecting a branch only updates the branch chip.
    setUrl(`${repo.html_url}.git`);
    if (suggestion) setSuggestion(null);
  }, [suggestion]);

  const handlePickBranch = useCallback((b: { name: string }) => {
    setBranch(b.name);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Clone project from git</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {githubConnected ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              GitHub connected — you can clone private repos.
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
              <span className="text-muted-foreground">
                Tip: connect GitHub to clone private repos.
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => void handleConnectGithub()}
              >
                <Github className="mr-1.5 h-3 w-3" />
                Connect
              </Button>
            </div>
          )}
          {/* URL input (always visible) */}
          <div className="flex items-center gap-2">
            <Input
              placeholder="https://github.com/owner/repo.git"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (suggestion) setSuggestion(null);
              }}
              autoFocus
              spellCheck={false}
              className="font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit();
              }}
            />
            {branch && (
              <div className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs">
                <GitBranch className="h-3 w-3" />
                <span className="font-mono">{branch}</span>
                <button
                  type="button"
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setBranch(null)}
                  title="Clear branch (uses default)"
                >
                  ×
                </button>
              </div>
            )}
          </div>
          {suggestion && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <div className="mb-1.5">
                <span className="font-mono">{suggestion.attemptedName}</span> already exists in the workspace.
              </div>
              <div className="flex items-center gap-2">
                <span>Use</span>
                <span className="font-mono font-medium">{suggestion.suggestedName}</span>
                <span>instead?</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-xs"
                  onClick={() => void submit(suggestion.suggestedName)}
                  disabled={isSubmitting}
                >
                  Use suggestion
                </Button>
              </div>
            </div>
          )}
          {isSubmitting && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Cloning…
            </div>
          )}

          {/* Picker section: only when connected. URL input above remains the
              manual-paste path; this is the discoverable browse path. */}
          {githubConnected && (
            <>
              <div className="my-1 border-t border-border" />
              <InvitationsStrip provider="github" enabled={open} />
              {pickedRepo ? (
                <BranchPicker
                  repo={pickedRepo}
                  onSelect={handlePickBranch}
                  onBack={() => {
                    setPickedRepo(null);
                    setBranch(null);
                  }}
                />
              ) : (
                <RepoPicker provider="github" onSelect={handlePickRepo} enabled={open} />
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Clone{branch ? ` @ ${branch}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewProjectFromGitDialog;
