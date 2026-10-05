import type { RemoteWorkerSession } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { useProjects } from '@src/hooks/use-projects';

export interface ApproveLiveSession {
  /** Approve the session. When it has nowhere to run — a person-to-person chat
   *  has no project by design — the host first picks a project; resolves once
   *  approved, or untouched if the picker is dismissed. */
  approve: (session: RemoteWorkerSession) => Promise<void>;
  /** The project picker; render it once wherever the hook is used. */
  picker: ReactNode;
}

/**
 * The host's Approve, shared by the live-session view and the session card in
 * the conversation. The backend refuses an approval with nowhere to run (409)
 * rather than approving a turn that can only fail, so the place is asked for
 * here, before the call: a project, or "No project" — the instance's temp folder.
 */
export function useApproveLiveSession(): ApproveLiveSession {
  const { t } = useLingui();
  const [pending, setPending] = useState<RemoteWorkerSession | null>(null);
  const settle = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const { projects, isLoading } = useProjects({ enabled: !!pending });
  const items = useMemo(() => projectEntitiesToSelectorItems(projects).filter((p) => !!p.path), [projects]);

  const approve = useCallback(async (session: RemoteWorkerSession) => {
    if (!(await session.needsProjectToApprove())) return session.approve();
    return new Promise<void>((resolve, reject) => {
      settle.current = { resolve, reject };
      setPending(session);
    });
  }, []);

  const close = useCallback(() => {
    settle.current?.resolve();
    settle.current = null;
    setPending(null);
  }, []);

  const choose = useCallback(
    (where: { projectId?: string; scratch?: boolean }) => {
      const session = pending;
      const done = settle.current;
      settle.current = null;
      setPending(null);
      if (!session || !done) return;
      session.approve(undefined, where.projectId, { scratch: where.scratch }).then(done.resolve, done.reject);
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
          variant="outline"
          className="h-7 shrink-0"
          onClick={() => choose({ scratch: true })}
          title={t`Run it in this machine's live-session temp folder — always the same folder`}
          data-testid="live-session-no-project"
        >
          {t`No project`}
        </Button>
      }
    />
  );

  return { approve, picker };
}
