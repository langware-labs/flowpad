import { CollaborationRoom, getOrCreateLocalMemberId, Project, TypeId, ViewType } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import { Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { ProjectViewHeader } from './ProjectViewHeader';
import { RoomHeader } from './RoomHeader';
import { SharedSessionsList } from './SharedSessionsList';
import { SharedSessionView } from './SharedSessionView';
import { StartRoomDialog } from './StartRoomDialog';

const HEARTBEAT_INTERVAL_MS = 15_000;

function EmptyState() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <Users className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <div className="text-lg font-semibold">
          <Trans>No collaboration open</Trans>
        </div>
        <div className="text-sm text-muted-foreground">
          <Trans>Meet collaborators on a project to assist and get assisted.</Trans>
        </div>
      </div>
      <Button onClick={() => setDialogOpen(true)}>
        <Trans>Start a collaboration</Trans>
      </Button>
      <StartRoomDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

/**
 * The collaboration room. Its core content is its **Shared Sessions**
 * (RemoteWorkerSession) — a guest driving work on a host's machine — NOT an
 * asset browser. Left: the room's sessions. Right: the selected session (a chat
 * of the prompt/PromptCompletion exchange; the host also gets a Disconnect control).
 */
export function CollaborationPage() {
  const { currentDock } = useDockNavigation();

  const isActiveView = currentDock?.viewType === ViewType.PROJECT;
  const { projectTypeId, roomId, sessionId } = useMemo(
    () =>
      isActiveView
        ? DockPointer.parseProjectPointer(currentDock?.pointer)
        : { projectTypeId: null, roomId: null, sessionId: null },
    [isActiveView, currentDock?.pointer],
  );

  const roomTypeId = useMemo(() => {
    if (!roomId) return null;
    try {
      return new TypeId(CollaborationRoom.type, roomId);
    } catch {
      return null;
    }
  }, [roomId]);

  const { data: project } = useEntity<Project>(projectTypeId, { watch: true });
  const { data: room } = useEntity<CollaborationRoom>(roomTypeId, { watch: true });
  const localMemberId = useMemo(() => (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : null), []);

  // Heartbeat into the room.
  useEffect(() => {
    if (!room || !localMemberId) return;
    let stopped = false;
    const beat = async () => {
      if (stopped) return;
      try {
        await room.heartbeat(localMemberId);
      } catch {
        // ignore transient failures
      }
    };
    void beat();
    const hb = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(hb);
    };
  }, [room, localMemberId]);

  if (!projectTypeId) return <EmptyState />;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ProjectViewHeader project={project} localMemberId={localMemberId} />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 flex-shrink-0 overflow-y-auto border-e">
          {roomId ? (
            <SharedSessionsList projectId={project.id} roomId={roomId} activeSessionId={sessionId} />
          ) : (
            <div className="p-4 text-xs text-muted-foreground">
              <Trans>No room selected.</Trans>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {room && (
            <RoomHeader room={room} isHost={room.isHost(localMemberId ?? undefined)} isSupport={!!project?.system} />
          )}
          <div className="min-h-0 flex-1">
            {sessionId ? (
              <SharedSessionView sessionId={sessionId} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Trans>Select a shared session, or execute a prompt to start one.</Trans>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
