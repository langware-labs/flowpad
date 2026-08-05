import {
  type BranchSummary,
  type RepoSummary,
  isHubOnly,
  navigator as sdkNavigator,
} from '@sdk';
import { BranchPicker } from '@src/components/git/BranchPicker';
import { CreatePrivateRepoForm } from '@src/components/git/CreatePrivateRepoForm';
import { RepoPicker } from '@src/components/git/RepoPicker';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { StepList } from '@src/components/ui/step-list';
import { useDesktops } from '@src/hooks/use-desktops';
import { useAuth } from '@src/hooks/useAuth';
import { contentInstallSpec, parseInstallIntent } from '@src/lib/content-install';
import { Trans } from '@lingui/react/macro';
import { ExternalLink, GitBranch, Lock, PackagePlus } from 'lucide-react';
import { useMemo, useState } from 'react';

type PickerView = 'repos' | 'branches' | 'create' | 'confirm';

export default function InstallLanding() {
  const parsed = useMemo(() => parseInstallIntent(window.location.search), []);
  const { user } = useAuth();
  const { launch, steps, launchUrl } = useDesktops();
  const [view, setView] = useState<PickerView>('repos');
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [branch, setBranch] = useState<BranchSummary | null>(null);
  const [started, setStarted] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const failed = steps.some((step) => step.status === 'error');

  if (!isHubOnly()) {
    return <EntryMessage title="Open this link on Flowpad Hub" detail="Content installation launches a cloud desktop from the Hub." />;
  }
  if (!parsed.ok) {
    return <EntryMessage title="Invalid install link" detail={parsed.message} />;
  }

  const intent = parsed.intent;
  const selectRepo = (selected: RepoSummary) => {
    setRepo(selected);
    setBranch(null);
    setView('branches');
  };
  const createdRepo = (created: RepoSummary) => {
    setRepo(created);
    setBranch({ name: created.default_branch, protected: false });
    setView('confirm');
  };
  const selectBranch = (selected: BranchSummary) => {
    setBranch(selected);
    setView('confirm');
  };
  const startInstall = () => {
    if (!repo || !branch) return;
    setStarted(true);
    void launch({
      name: repo.name,
      sandboxProject: {
        name: repo.name,
        gitOrigin: { ...repo.git_origin, branch: branch.name },
        install: contentInstallSpec(intent),
      },
    });
  };

  const page = (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg text-center">
        {started ? (
          <div className="rounded-lg border border-border p-5 text-left" data-testid="install-progress">
            <p className="mb-3 text-sm font-medium">
              {launchUrl ? (
                <Trans>Your CloudNSite workspace is ready</Trans>
              ) : failed ? (
                <Trans>Couldn't finish preparing your workspace</Trans>
              ) : (
                <Trans>Preparing your workspace…</Trans>
              )}
            </p>
            <StepList steps={steps} testIdPrefix="install" className="flex flex-col gap-1.5" />
            {launchUrl && (
              <Button asChild size="sm" className="mt-4 w-full gap-1.5">
                <a href={launchUrl} target="_blank" rel="noreferrer" data-testid="install-open">
                  <ExternalLink className="h-3.5 w-3.5" />
                  <Trans>Open the project</Trans>
                </a>
              </Button>
            )}
          </div>
        ) : cancelled ? (
          <p className="text-sm text-muted-foreground"><Trans>Nothing was installed. You can close this tab.</Trans></p>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {page}
      <Dialog open={!started && !cancelled} onOpenChange={(open) => !open && setCancelled(true)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="install-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5" />
              Where do you want to install {intent.name}?
            </DialogTitle>
            <DialogDescription>
              Flowpad will propose the install on <code>flowpad/install-cloudnsite-agents</code>. Your default branch is not changed and no pull request is opened automatically.
            </DialogDescription>
          </DialogHeader>

          {!user ? (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm">
              <p className="mb-3"><Trans>Sign in to choose one of your GitHub repositories.</Trans></p>
              <Button onClick={() => window.location.assign(sdkNavigator.getLoginWithCallbackUrl(window.location.href))}>
                <Trans>Sign in to Flowpad</Trans>
              </Button>
            </div>
          ) : view === 'repos' ? (
            <div className="flex flex-col gap-3">
              <RepoPicker provider="github" allowedRoles={['admin', 'write']} onSelect={selectRepo} />
              <Button variant="outline" className="w-full gap-2" onClick={() => setView('create')} data-testid="install-create-private">
                <Lock className="h-4 w-4" /> <Trans>Create a private repository</Trans>
              </Button>
            </div>
          ) : view === 'branches' && repo ? (
            <BranchPicker repo={repo} onSelect={selectBranch} onBack={() => setView('repos')} />
          ) : view === 'create' ? (
            <CreatePrivateRepoForm onBack={() => setView('repos')} onCreated={createdRepo} />
          ) : repo && branch ? (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm" data-testid="install-confirmation">
              <div className="flex items-center gap-2 font-medium"><GitBranch className="h-4 w-4" />{repo.full_name}</div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{branch.name}</div>
              <p className="mt-3 text-xs text-muted-foreground">
                {intent.name} stays linked as shared project context after the workspace opens.
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelled(true)} data-testid="install-cancel"><Trans>Cancel</Trans></Button>
            {user && view === 'confirm' && (
              <Button onClick={startInstall} disabled={!repo || !branch} data-testid="install-launch">
                <Trans>Launch workspace</Trans>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EntryMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-border p-6 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
