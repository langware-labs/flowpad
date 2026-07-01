import { Users } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useRemoteWorkerSessions } from '@src/hooks/useRemoteWorkerSessions';
import { SharedSessionCard } from './SharedSessionCard';

interface Props {
  projectId: string;
  roomId: string;
  activeSessionId: string | null;
}

/**
 * The room's shared sessions — each a guest driving work on a host's machine.
 * This replaces the old asset-menu sidebar (Conversations/Docs/Plans/Skills):
 * a collaboration room IS its shared sessions. Selection is URL-first via
 * `openProject(projectId, { roomId, sessionId })`.
 */
export function SharedSessionsList({ projectId, roomId, activeSessionId }: Props) {
  const { navigation } = useDockNavigation();
  const { items, isLoading } = useRemoteWorkerSessions(roomId);

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        <Trans>Shared sessions</Trans>
      </div>
      {items.length === 0 ? (
        <div className="px-2 py-4 text-xs text-muted-foreground">
          {isLoading ? <Trans>Loading…</Trans> : (
            <Trans>No shared sessions yet. Executing a prompt starts one.</Trans>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((s) => (
            <SharedSessionCard
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onClick={() =>
                navigation.openProject(projectId, { roomId, sessionId: s.id })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
