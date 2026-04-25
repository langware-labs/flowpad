import {
  AgenticProcess,
  CollaborationRoom,
  dataContext,
  getOrCreateLocalMemberId,
  Project,
  Shell,
  TypeId,
  ViewType,
} from '@sdk';
import type { TerminalTab } from '@src/hooks/useActiveTerminals';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer, getProcessProjectDockPointer } from '@src/navigation/DockPointer';
import { TabbedTerminal } from '@src/components/terminal';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollaborationHeader } from './CollaborationHeader';
import { CollaborationSidebar } from './CollaborationSidebar';
import { CollaborationChat } from './CollaborationChat';
import { RoomTabs, type RoomTab } from './RoomTabs';
import { RoomHeader } from './RoomHeader';
import { StartRoomDialog } from './StartRoomDialog';

const HEARTBEAT_INTERVAL_MS = 15_000;

function EmptyState() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <Users className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <div className="text-lg font-semibold">No collaboration open</div>
        <div className="text-sm text-muted-foreground">
          Meet collaborators on a project to assist and get assisted.
        </div>
      </div>
      <Button onClick={() => setDialogOpen(true)}>Start a collaboration</Button>
      <StartRoomDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

export function CollaborationPage() {
  const { currentDock, navigation } = useDockNavigation();
  const { toast } = useToast();
  // MRU stack of shell ids within the current room — most-recent first.
  const mruRef = useRef<string[]>([]);

  const isActiveView = currentDock?.viewType === ViewType.PROJECT;
  const { projectId, roomId, tabTypeId } = useMemo(
    () =>
      isActiveView
        ? DockPointer.parseProjectPointer(currentDock?.pointer)
        : { projectId: null, roomId: null, tabTypeId: null },
    [isActiveView, currentDock?.pointer],
  );

  const projectTypeId = useMemo(() => {
    if (!projectId) return null;
    try {
      return new TypeId(Project.type, projectId);
    } catch {
      return null;
    }
  }, [projectId]);

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

  // ── Room bootstrap (auto-create when first tab opens without one) ────────
  const ensureRoomForTabOpen = useCallback(async (): Promise<CollaborationRoom | null> => {
    if (room) return room;
    if (!project) return null;
    try {
      const fresh = await CollaborationRoom.create({
        projectId: project.id,
        hostName: project.displayName || 'Host',
        hostMemberId: localMemberId ?? undefined,
      });
      return fresh;
    } catch (err) {
      console.warn('[CollaborationPage] failed to auto-create room', err);
      return null;
    }
  }, [room, project, localMemberId]);

  // ── Tab event handlers ──────────────────────────────────────────────────
  const touchMru = useCallback((shellId: string) => {
    mruRef.current = [shellId, ...mruRef.current.filter((id) => id !== shellId)];
  }, []);

  const handleTabClick = useCallback(
    (shellId: string, tab: TerminalTab) => {
      if (!projectId || !roomId) return;
      touchMru(shellId);
      navigation.openDock(getProcessProjectDockPointer(tab, projectId, roomId));
    },
    [navigation, projectId, roomId, touchMru],
  );

  const handleTabClose = useCallback(
    (shellId: string) => {
      if (!projectId) return;
      mruRef.current = mruRef.current.filter((id) => id !== shellId);
      if (!mruRef.current[0]) {
        navigation.openDock(
          roomId
            ? DockPointer.forProject(projectId, { roomId })
            : DockPointer.forProject(projectId),
        );
      }
    },
    [navigation, projectId, roomId],
  );

  const handleTabOpen = useCallback(
    async (tab: TerminalTab) => {
      if (!project) return;
      // If a tab is opened before any room exists, start one on the fly.
      let activeRoom = room;
      if (!activeRoom) {
        activeRoom = await ensureRoomForTabOpen();
        if (!activeRoom) return;
      }

      // For Claude tabs: kick the backend `open` action explicitly so the
      // process goes from NEW → LIVE with a Shell and the PTY attaches on
      // this client. react-router's parent loader doesn't always revalidate
      // on intra-route splat changes, so we can't rely on the route loader
      // to do this for the in-app create path.
      const proc = tab.agenticProcess;
      let shell = tab.shell ?? null;
      if (proc && !shell?.id) {
        try {
          const live =
            AgenticProcess.getByIdFromCache<AgenticProcess>(proc.id) ??
            (await AgenticProcess.getById<AgenticProcess>(proc.id).catch(() => null));
          if (live) {
            await live.start({ visible: true });
            if (live.shell_id) {
              shell =
                Shell.getByIdFromCache<Shell>(live.shell_id) ??
                (await Shell.getById<Shell>(live.shell_id).catch(() => null)) ??
                null;
            }
          }
        } catch (err) {
          console.warn('[CollaborationPage] failed to start claude process', err);
        }
      }
      if (shell && shell.collaboration_room_id !== activeRoom.id) {
        try {
          shell.collaboration_room_id = activeRoom.id;
          await shell.save();
        } catch (err) {
          console.warn('[CollaborationPage] failed to tag shell with room id', err);
        }
      }

      // Bind process ↔ room so membership is queryable from either side.
      if (proc?.id) {
        try {
          const live =
            AgenticProcess.getByIdFromCache<AgenticProcess>(proc.id) ??
            (await AgenticProcess.getById<AgenticProcess>(proc.id).catch(() => null));
          if (live && live.collaboration_room_id !== activeRoom.id) {
            live.collaboration_room_id = activeRoom.id;
            await live.save();
          }
          await activeRoom.addProcess(proc.id);
        } catch (err) {
          console.warn('[CollaborationPage] failed to bind process to room', err);
        }
      }

      const enriched: TerminalTab = { ...tab, shell: shell ?? tab.shell };
      touchMru(enriched.shellId);
      navigation.openDock(getProcessProjectDockPointer(enriched, project.id, activeRoom.id));
    },
    [navigation, project, room, ensureRoomForTabOpen, touchMru],
  );

  // RoomTabs — non-terminal tabs (markdown docs, future: skills/agents/plans).
  // Hooks MUST come before any early returns to keep render order stable.
  const [roomTabs, setRoomTabs] = useState<RoomTab[]>([]);
  const [activeRoomTabKey, setActiveRoomTabKey] = useState<string | null>(null);

  const handleOpenRoomTab = useCallback((tab: RoomTab) => {
    setRoomTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]));
    setActiveRoomTabKey(tab.key);
  }, []);

  const handleCloseRoomTab = useCallback((key: string) => {
    setRoomTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      setActiveRoomTabKey((cur) => {
        if (cur !== key) return cur;
        return next.length > 0 ? next[next.length - 1].key : null;
      });
      return next;
    });
  }, []);

  if (!projectId) return <EmptyState />;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
    );
  }

  const handleShareActiveTab = async () => {
    const activeShellId = dataContext.activeShellId;
    if (!activeShellId) {
      toast({ title: 'No active tab', description: 'Open a terminal tab first.' });
      return;
    }
    if (!room) {
      toast({ title: 'No active room', description: 'Start a room first.' });
      return;
    }
    try {
      const shell = Shell.getByIdFromCache(activeShellId) ?? (await Shell.getById(activeShellId));
      if (!shell) return;
      shell.collaboration_room_id = room.id;
      await shell.save();
      toast({ title: 'Shared to room', description: shell.name ?? 'Tab shared.' });
    } catch (err) {
      console.error('[CollaborationPage] share failed', err);
      toast({ title: 'Share failed', description: String((err as Error).message ?? err) });
    }
  };

  const isHost = project.isHost(localMemberId ?? undefined);

  return (
    <div className="flex h-full flex-col">
      <CollaborationHeader project={project} localMemberId={localMemberId} />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 flex-shrink-0 overflow-y-auto border-r">
          <CollaborationSidebar projectId={project.id} onOpenTab={handleOpenRoomTab} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {room && (
            <RoomHeader
              room={room}
              isHost={room.isHost(localMemberId ?? undefined)}
              isSupport={!!project?.system}
            />
          )}
          {isHost && (
            <div className="flex h-9 flex-shrink-0 items-center justify-end gap-2 border-b bg-muted/30 px-3 text-xs">
              <span className="text-muted-foreground">Host controls:</span>
              <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void handleShareActiveTab()}>
                Share active tab into room
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ResizablePanelGroup direction="vertical">
              {roomTabs.length > 0 && (
                <>
                  <ResizablePanel defaultSize={35} minSize={15}>
                    <RoomTabs
                      tabs={roomTabs}
                      activeKey={activeRoomTabKey}
                      onActivate={setActiveRoomTabKey}
                      onClose={handleCloseRoomTab}
                      className="h-full"
                    />
                  </ResizablePanel>
                  <ResizableHandle />
                </>
              )}
              <ResizablePanel defaultSize={roomTabs.length > 0 ? 35 : 60} minSize={20}>
                <TabbedTerminal
                  className="h-full"
                  collaborationRoomId={room?.id ?? null}
                  spawnProjectId={project.id}
                  addTabButton
                  onTabClick={handleTabClick}
                  onTabClose={handleTabClose}
                  onTabOpen={handleTabOpen}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={roomTabs.length > 0 ? 30 : 40} minSize={20}>
                <CollaborationChat />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
