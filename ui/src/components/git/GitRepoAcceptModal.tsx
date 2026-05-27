import { useEffect, useMemo, useState } from 'react';
import {
  ActionInfo,
  AgenticProcess,
  ClaudeCliOptions,
  ConnectionManager,
  dataManager,
  GitRepo,
  Project,
  QueryRequest,
  Shell,
  TypeId,
} from '@sdk';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { useProject } from '@sdk/react/hooks';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { EntityChip } from '@src/components/conversation/EntityChip';
import {
  deriveRepoState,
  type ProjectGitState,
  type ProjectRepoCase,
  useProjectRepoState,
} from '@src/hooks/use-project-repo-state';
import { Button } from '@src/components/ui/button';
import { GitBranch, ExternalLink, Loader2, Lock, Play, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@src/lib/utils';

interface GitRepoAcceptModalProps {
  gitRepoTypeId: TypeId;
  open: boolean;
  onClose: () => void;
}

/** Map state → human-readable button label. */
function labelFor(state: ProjectRepoCase | null, projectName: string): string {
  switch (state) {
    case 'CLONE':
      return `Clone to ${projectName}`;
    case 'CHECKOUT':
      return 'Check out this branch';
    case 'COMMIT_AND_PULL':
      return 'Commit changes and pull';
    case 'PULL':
      return 'Pull changes';
    case 'INCOMPATIBLE_REPO':
      return 'Cannot clone into current project';
    case 'NO_WORKDIR':
      return 'Project has no workdir';
    case 'UP_TO_DATE':
      return 'Already up to date';
    default:
      return 'Loading…';
  }
}

/** Map state → backend action sub-path. */
function actionSubpathFor(state: ProjectRepoCase | null): string | null {
  switch (state) {
    case 'CLONE':
      return 'clone-to-project';
    case 'CHECKOUT':
      return 'checkout-branch';
    case 'PULL':
      return 'pull';
    case 'COMMIT_AND_PULL':
      return 'commit-and-pull';
    default:
      return null;
  }
}

export function GitRepoAcceptModal({ gitRepoTypeId, open, onClose }: GitRepoAcceptModalProps) {
  const { data: gitRepo } = useEntity<GitRepo>(gitRepoTypeId);
  const { project: dockProject } = useProject();

  // Project picker — list all the user's projects with the dock-selected
  // one preselected. Falls back to the first project if dock has none.
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: projects = [] } = useEntitiesQuery<Project>(projectsQuery);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedProjectId) return;
    if (dockProject?.id) {
      setSelectedProjectId(dockProject.id);
    } else if (projects.length > 0 && projects[0].id) {
      setSelectedProjectId(projects[0].id);
    }
  }, [selectedProjectId, dockProject?.id, projects]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const projectTypeId = selectedProject?.typeId ?? null;

  const { state, projectGit, loading: stateLoading, refresh, setProjectGit } =
    useProjectRepoState(projectTypeId, gitRepo ?? null);

  // ─── Status line: subscribe to DataOp UPDATE frames on the GitRepo
  //     typeid. The backend git_repo actions emit {..., status: "<text>"}
  //     UPDATE frames at step boundaries; we render the latest one.
  const [statusLine, setStatusLine] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    const cm = ConnectionManager.getInstance();
    const target = gitRepoTypeId.toString();
    const handler = (typeIdStr: string, op: string, data: any) => {
      if (typeIdStr !== target) return;
      if (op !== 'update') return;
      const status = data && typeof data === 'object' ? (data as { status?: unknown }).status : null;
      if (typeof status === 'string' && status) {
        setStatusLine(status);
      }
    };
    cm.on('on_data_op', handler);
    return () => cm.off('on_data_op', handler);
  }, [open, gitRepoTypeId]);

  // ─── Run the appropriate action. The backend returns the post-action
  //     project/git-state snapshot; we feed it back through the state hook
  //     so the modal re-derives without another GET.
  const runAction = async () => {
    const subpath = actionSubpathFor(state);
    if (!subpath || !projectTypeId) return;
    if (state === 'COMMIT_AND_PULL' && !commitMessage.trim()) {
      toast.error('Enter a commit message first.');
      return;
    }
    setBusy(true);
    setStatusLine('Starting…');
    try {
      const info = new ActionInfo('git_repo', gitRepoTypeId.type, gitRepoTypeId.id, 'POST');
      info.subpath = subpath;
      const body: Record<string, unknown> = {
        project_typeid: `${projectTypeId.type}-${projectTypeId.id}`,
      };
      if (state === 'COMMIT_AND_PULL') {
        body.message = commitMessage.trim();
      }
      info.bodyParameters = body;
      const result = await dataManager.callAction<unknown, { message?: string; git_state?: ProjectGitState }>(info);
      if (result?.git_state) {
        setProjectGit(result.git_state);
      } else {
        await refresh();
      }
      setCommitted(true);
    } catch (err) {
      console.error('[GitRepoAcceptModal] action failed', err);
      const msg = err instanceof Error ? err.message : 'Action failed';
      setStatusLine(`Failed: ${msg}`);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  // ─── Post-success: is the local state finally compatible with the shared
  //     repo+branch? Use the same reducer on the latest snapshot.
  const finalState = deriveRepoState(projectGit, gitRepo ?? null);
  const ready =
    committed &&
    (finalState === 'UP_TO_DATE' || finalState === 'PULL') &&
    !busy;

  const handleStartSession = async () => {
    if (!selectedProject?.fs_storage_mount_path) return;
    try {
      const cli = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });
      const proc = await new AgenticProcess({
        cli_config: cli.toJson(),
        context_data: { project_id: selectedProject.id ?? undefined },
        workdir: selectedProject.fs_storage_mount_path,
        visible: true,
        shared_context_entities: [gitRepoTypeId.toString()],
      }).save();
      await proc.start({ instruction: '' });
      proc.openTerminalDock();
      onClose();
    } catch (err) {
      console.error('[GitRepoAcceptModal] start session failed', err);
      toast.error('Failed to start session');
    }
  };

  const handleOpenTerminal = async () => {
    if (!selectedProject?.fs_storage_mount_path) return;
    try {
      const shell = await new Shell({
        name: 'Work',
        workdir: selectedProject.fs_storage_mount_path,
      }).save();
      shell.openTerminalDock?.();
      onClose();
    } catch (err) {
      console.error('[GitRepoAcceptModal] open terminal failed', err);
      toast.error('Failed to open terminal');
    }
  };

  const actionSubpath = actionSubpathFor(state);
  const canRun = !busy && !!projectTypeId && actionSubpath !== null && !!gitRepo;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitBranch className="h-4 w-4" />
            {gitRepo?.full_name || gitRepoTypeId.id}
            {gitRepo?.private && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-px text-[10px] uppercase text-amber-700 dark:text-amber-300">
                <Lock className="h-2.5 w-2.5" /> private
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-xs">
          {gitRepo?.description && (
            <p className="text-muted-foreground">{gitRepo.description}</p>
          )}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Branch:</span>
            <span className="font-mono">{gitRepo?.branch}</span>
            {gitRepo?.html_url && (
              <a
                href={gitRepo.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                title="Open on GitHub"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground">Project</label>
            <select
              value={selectedProjectId ?? ''}
              onChange={(e) => { setSelectedProjectId(e.target.value); setCommitted(false); setStatusLine(''); }}
              disabled={busy}
              className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
              data-testid="git-repo-accept-project-select"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id ?? ''}>
                  {p.name ?? p.id}
                </option>
              ))}
            </select>
            {selectedProject?.typeId && (
              <EntityChip
                entity={{ typeId: selectedProject.typeId, type: 'project', name: selectedProject.name }}
                size="inline"
              />
            )}
          </div>

          {state === 'COMMIT_AND_PULL' && !committed && (
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message…"
              disabled={busy}
              className="rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
              data-testid="git-repo-accept-commit-message"
            />
          )}

          {stateLoading ? (
            <div className="flex items-center gap-2 py-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading project git state…
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Button
                onClick={() => void runAction()}
                disabled={!canRun}
                title={
                  state === 'INCOMPATIBLE_REPO'
                    ? "This project's git root maps to a different repo — pick another project."
                    : state === 'NO_WORKDIR'
                    ? 'The selected project has no workdir set — configure it in project settings first.'
                    : state === 'UP_TO_DATE'
                    ? 'Already up to date'
                    : undefined
                }
                className={cn(
                  'w-full justify-center gap-2',
                  busy && 'opacity-70',
                )}
                data-testid="git-repo-accept-action"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {labelFor(state, selectedProject?.name ?? 'project')}
              </Button>
              {statusLine && (
                <div
                  className={cn(
                    'rounded border px-2 py-1 font-mono text-[11px]',
                    statusLine.startsWith('Failed')
                      ? 'border-destructive/40 bg-destructive/5 text-destructive'
                      : 'border-border bg-muted/30 text-muted-foreground',
                  )}
                  role="status"
                  data-testid="git-repo-accept-status"
                >
                  {statusLine}
                </div>
              )}
            </div>
          )}

          {ready && (
            <div className="flex items-center gap-2 border-t border-border pt-3">
              <Button
                onClick={() => void handleStartSession()}
                className="flex-1 justify-center gap-2"
                data-testid="git-repo-accept-start-session"
              >
                <Play className="h-3 w-3" /> Start session
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleOpenTerminal()}
                className="flex-1 justify-center gap-2"
                data-testid="git-repo-accept-open-terminal"
              >
                <Terminal className="h-3 w-3" /> Open terminal
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
