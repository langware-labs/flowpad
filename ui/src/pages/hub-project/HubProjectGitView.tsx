import {
  getRepoBranches,
  getRepoLog,
  Project,
  TypeId,
  type ConversationParticipant,
  type RepoBranch,
  type RepoCommit,
} from '@sdk';
import { Trans } from '@lingui/react/macro';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  participantInitials,
  participantLabel,
  participantRoleLabel,
} from '@src/components/conversation/participant-display';
import { formatRelative } from '@src/components/git/relative-time';
import { CopyButton } from '@src/components/ui/copy-button';
import { useHostedRepo } from '@src/hooks/use-hosted-repo';
import { useMembers } from '@src/hooks/use-members';
import { hubProjectHomeDock } from '@src/lib/hub-page-url';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useMemo, type ReactNode } from 'react';

const ROW = 'flex items-center gap-3 border-b border-border/50 px-4 py-2.5 text-sm last:border-b-0';
const MUTED = 'text-xs text-muted-foreground';

function Card({ title, testId, children }: { title: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="rounded-lg border border-border bg-card">{children}</div>
    </div>
  );
}

function MutedRow({ children }: { children: ReactNode }) {
  return (
    <div className={ROW}>
      <span className={MUTED}>{children}</span>
    </div>
  );
}

function Pending() {
  return (
    <p className="text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );
}

/** Loading, the read's error, or `children(data)`. */
function QueryGate<T>({
  query,
  what,
  children,
}: {
  query: UseQueryResult<T>;
  what: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Pending />;
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <p className="text-sm text-destructive" data-testid={`project-git-${what}-error`}>
        <Trans>
          Could not read {what}: {message}
        </Trans>
      </p>
    );
  }
  return <>{children(query.data)}</>;
}

function CloneCard({ cloneUrl, folder }: { cloneUrl: string; folder: string }) {
  const command = `git clone ${cloneUrl} ${folder}`;
  return (
    <Card title={<Trans>Clone</Trans>} testId="project-git-clone">
      <div className={ROW}>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{command}</span>
        <CopyButton
          value={command}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-semibold hover:bg-accent"
          label={<Trans>Copy</Trans>}
          copiedLabel={<Trans>Copied</Trans>}
        />
      </div>
      <MutedRow>
        <Trans>Signs in with your Flowpad account — no password, no token in the URL.</Trans>
      </MutedRow>
    </Card>
  );
}

export function BranchesCard({ branches, defaultBranch }: { branches: RepoBranch[]; defaultBranch: string }) {
  return (
    <Card title={<Trans>Branches · {branches.length}</Trans>} testId="project-git-branches">
      {branches.length === 0 && (
        <MutedRow>
          <Trans>No branches yet — the first push creates {defaultBranch}.</Trans>
        </MutedRow>
      )}
      {branches.map((b) => (
        <div key={b.name} className={ROW} data-testid={`project-git-branch-${b.name}`}>
          <span className="font-mono text-sm">{b.name}</span>
          {b.name === defaultBranch && (
            <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              <Trans>default</Trans>
            </span>
          )}
          <span className={`min-w-0 flex-1 truncate ${MUTED}`}>{b.subject}</span>
          <span className={MUTED}>
            {b.author} · {formatRelative(b.date ?? '')}
          </span>
          <span className={`font-mono ${MUTED}`}>{b.sha?.slice(0, 7)}</span>
        </div>
      ))}
    </Card>
  );
}

export function AccessCard({ members }: { members: ConversationParticipant[] }) {
  return (
    <Card title={<Trans>Who has access · {members.length}</Trans>} testId="project-git-access">
      {members.map((m) => {
        const name = participantLabel(m);
        const role = participantRoleLabel(m);
        return (
          <div key={m.user_id || name} className={ROW}>
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px]">
              {participantInitials(m)}
            </span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {role && <span className="rounded-md border border-border px-2 text-xs">{role}</span>}
          </div>
        );
      })}
    </Card>
  );
}

export function CommitsCard({ commits, branch }: { commits: RepoCommit[]; branch: string }) {
  return (
    <Card title={<Trans>Recent commits on {branch}</Trans>} testId="project-git-commits">
      {commits.length === 0 && (
        <MutedRow>
          <Trans>No commits yet.</Trans>
        </MutedRow>
      )}
      {commits.map((c) => (
        <div key={c.sha} className={ROW}>
          <span className={`font-mono ${MUTED}`}>{c.sha.slice(0, 7)}</span>
          <span className="min-w-0 flex-1 truncate">{c.subject}</span>
          <span className={MUTED}>
            {c.author} · {formatRelative(c.date)}
          </span>
        </div>
      ))}
    </Card>
  );
}

/** The project's hub-hosted repo: clone command, branches, who has access, recent commits. */
export function HubProjectGitView({ projectId }: { projectId: string }) {
  const { navigation } = useDockNavigation();
  const projectTypeId = useMemo(() => new TypeId(Project.type, projectId), [projectId]);
  const repo = useHostedRepo(projectId);
  const repoRef = repo.data?.repo;
  const branches = useQuery({
    queryKey: ['repo-branches', repoRef],
    queryFn: () => getRepoBranches(repoRef!),
    enabled: !!repoRef,
    retry: 1,
  });
  const commits = useQuery({
    queryKey: ['repo-log', repoRef],
    queryFn: () => getRepoLog(repoRef!, repo.data?.default_branch, 20),
    enabled: !!repoRef,
    retry: 1,
  });
  const { members, entity } = useMembers(projectTypeId);
  const projectName = (entity as { name?: string } | null | undefined)?.name ?? 'project';

  const body = () => {
    if (repo.isPending) return <Pending />;
    if (!repo.data) {
      return (
        <p className="text-sm text-muted-foreground">
          <Trans>This project has no hosted repository yet.</Trans>
        </p>
      );
    }
    const { clone_url, default_branch } = repo.data;
    return (
      <>
        <CloneCard cloneUrl={clone_url} folder={projectName} />
        <QueryGate query={branches} what="branches">
          {(data) => <BranchesCard branches={data} defaultBranch={default_branch} />}
        </QueryGate>
        <AccessCard members={members} />
        <QueryGate query={commits} what="commits">
          {(data) => <CommitsCard commits={data} branch={default_branch} />}
        </QueryGate>
      </>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="project-git-view">
      <button
        type="button"
        className="self-start text-xs text-muted-foreground hover:underline"
        onClick={() => navigation.openDock(hubProjectHomeDock(projectId))}
      >
        <Trans>← {projectName} home</Trans>
      </button>
      {body()}
    </div>
  );
}
