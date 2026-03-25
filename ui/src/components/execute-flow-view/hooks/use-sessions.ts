import { ActionInfo, dataContext } from '@sdk';
import { useAction } from '@src/hooks/use-action';

export interface WorkerSession {
  sessionId: string;
  title: string;
  timestamp: string;
}

export function useWorkerSessions() {
  const getWorkerSessionsActionInfo = new ActionInfo(
    'get-worker-sessions',
    dataContext.project?.typeId.type,
    dataContext.project?.typeId.id,
  );
  const { data: sessions, loading, error, refetch } = useAction<WorkerSession[]>(getWorkerSessionsActionInfo);

  return { sessions, loading, error, refresh: refetch };
}
