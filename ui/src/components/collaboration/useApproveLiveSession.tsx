import type { RemoteWorkerSession, SessionReplyPolicy } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { useProjects } from '@src/hooks/use-projects';

export interface ApproveLiveSession {
  /** Approve the session. When it has nowhere to run — a person-to-person chat
   *  has no project by design — the host first picks a project; resolves once
   *  approved, or untouched if the picker is dismissed. `replyPolicy` is set
   *  first — a prompt request's Run & Update (auto) vs Run (review). `turnKinds` is what the
   *  host left ticked; absent = everything the guest asked for. */
  approve: (
    session: RemoteWorkerSession,
    opts?: { replyPolicy?: SessionReplyPolicy; turnKinds?: string[] },
  ) => Promise<void>;
  /** The project picker; render it once wherever the hook is used. */
  picker: ReactNode;
}

/**
 * The host's Approve, shared by the live-session view and the session card in
 * the conversation. A chat with no project lets the host choose where it runs,
 * here, before the call: a project, or "Run (Skip project)" — the instance's
 * temp folder. The backend never needs the answer: with nothing picked it runs
 * in the temp folder.
 */
export function useApproveLiveSession(): ApproveLiveSession {
  const { t } = useLingui();
  // The approval waiting on the picker: which session, and the caller's promise to settle.
  const [pending, setPending] = useState<{
    session: RemoteWorkerSession;
    turnKinds?: string[];
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null>(null);
  const { projects, isLoading } = useProjects({ enabled: !!pending });
  const items = useMemo(() => projectEntitiesToSelectorItems(projects).filter((p) => !!p.path), [projects]);

  const approve = useCallback(
    async (session: RemoteWorkerSession, opts: { replyPolicy?: SessionReplyPolicy; turnKinds?: string[] } = {}) => {
      // Before the approval: the turn starts on approve and decides auto/review when it ends.
      if (opts.replyPolicy && session.effectiveReplyPolicy !== opts.replyPolicy) {
        await session.setReplyPolicy(opts.replyPolicy);
      }
      const { turnKinds } = opts;
      if (!(await session.needsProjectToApprove())) return session.approve(undefined, { turnKinds });
      return new Promise<void>((resolve, reject) => setPending({ session, turnKinds, resolve, reject }));
    },
    [],
  );

  const close = useCallback(() => {
    pending?.resolve();
    setPending(null);
  }, [pending]);

  const choose = useCallback(
    (where: { projectId?: string; scratch?: boolean }) => {
      if (!pending) return;
      setPending(null);
      pending.session
        .approve(where.projectId, { scratch: where.scratch, turnKinds: pending.turnKinds })
        .then(pending.resolve, pending.reject);
    },
    [pending],
  );
  const onSelect = useCallback((projectId: string) => choose({ projectId }), [choose]);

  const picker = (
    <ProjectSelectorModal
      open={!!pending}
      onOpenChange={(open) => !open && close()}
      projects={items}
      selectedId={null}
      onSelect={onSelect}
      isLoading={isLoading}
      title={t`Run this live session in which project?`}
      headerAction={
        <Button
          size="sm"
          className="h-7 shrink-0 bg-blue-600 text-white hover:bg-blue-500"
          onClick={() => choose({ scratch: true })}
          title={t`Run it without a project, in this machine's live-session temp folder — always the same folder`}
          data-testid="live-session-no-project"
        >
          {t`Run (Skip project)`}
        </Button>
      }
    />
  );

  return { approve, picker };
}
