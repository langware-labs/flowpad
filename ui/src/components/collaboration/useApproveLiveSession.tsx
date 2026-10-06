import type { RemoteWorkerSession, SessionRememberScope } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { useProjects } from '@src/hooks/use-projects';

export interface ApproveLiveSession {
  /** Approve the session. When it has nowhere to run — a person-to-person chat
   *  has no project by design — the host first picks a project; resolves once
   *  approved, or untouched if the picker is dismissed. */
  approve: (session: RemoteWorkerSession, options?: { remember?: SessionRememberScope }) => Promise<void>;
  /** The project picker; render it once wherever the hook is used. */
  picker: ReactNode;
}

/**
 * The host's Approve, shared by the live-session view and the session card in
 * the conversation. The backend refuses an approval with nowhere to run (409)
 * rather than approving a turn that can only fail, so the place is asked for
 * here, before the call: a project, or "Run (Skip project)" — the instance's temp folder.
 */
export function useApproveLiveSession(): ApproveLiveSession {
  const { t } = useLingui();
  // The approval waiting on the picker: which session, whether to remember the guest
  // ("Approve" does, "Approve once" does not), and the caller's promise to settle.
  const [pending, setPending] = useState<{
    session: RemoteWorkerSession;
    remember?: SessionRememberScope;
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null>(null);
  const { projects, isLoading } = useProjects({ enabled: !!pending });
  const items = useMemo(() => projectEntitiesToSelectorItems(projects).filter((p) => !!p.path), [projects]);

  const approve = useCallback(
    async (session: RemoteWorkerSession, options: { remember?: SessionRememberScope } = {}) => {
      if (!(await session.needsProjectToApprove())) return session.approve(options.remember);
      return new Promise<void>((resolve, reject) =>
        setPending({ session, remember: options.remember, resolve, reject }),
      );
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
        .approve(pending.remember, where.projectId, { scratch: where.scratch })
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
