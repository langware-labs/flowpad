import {
  CollaborationRoom,
  Conversation,
  getOrCreateLocalMemberId,
  Project,
  TypeId,
  ViewType,
} from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ProjectViewHeader } from './ProjectViewHeader';
import { CollaborationSidebar } from './CollaborationSidebar';
import { RoomTabs, type RoomTab } from './RoomTabs';
import { RoomHeader } from './RoomHeader';
import { StartRoomDialog } from './StartRoomDialog';

const HEARTBEAT_INTERVAL_MS = 15_000;

const ROOM_TABS_STORAGE_PREFIX = 'flowpad:roomTabs:';

interface PersistedRoomTabs {
  tabs: RoomTab[];
  activeKey: string | null;
}

function persistenceKey(projectId: string | null, roomId: string | null): string | null {
  // Prefer roomId scope (different rooms have different open sets); fall back
  // to projectId so refresh persists even when no room is in the URL yet.
  if (roomId) return ROOM_TABS_STORAGE_PREFIX + 'room:' + roomId;
  if (projectId) return ROOM_TABS_STORAGE_PREFIX + 'project:' + projectId;
  return null;
}

function readPersistedRoomTabs(key: string | null): PersistedRoomTabs {
  if (!key || typeof window === 'undefined') return { tabs: [], activeKey: null };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return { tabs: [], activeKey: null };
    const parsed = JSON.parse(raw) as PersistedRoomTabs;
    if (!Array.isArray(parsed.tabs)) return { tabs: [], activeKey: null };
    return parsed;
  } catch {
    return { tabs: [], activeKey: null };
  }
}

function writePersistedRoomTabs(key: string | null, value: PersistedRoomTabs): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / disabled storage errors
  }
}

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
  const { currentDock } = useDockNavigation();

  const isActiveView = currentDock?.viewType === ViewType.PROJECT;
  const { projectTypeId, roomId, conversationId: pointerConversationId } = useMemo(
    () =>
      isActiveView
        ? DockPointer.parseProjectPointer(currentDock?.pointer)
        : { projectTypeId: null, roomId: null, tabTypeId: null, conversationId: null },
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
  const localMemberId = useMemo(
    () => (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : null),
    [],
  );

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

  // RoomTabs — single tab strip in the room view. Holds non-terminal content
  // (markdown docs today; skills/agents/plans next). Persisted per-room (or
  // per-project when no room is selected) to sessionStorage so refresh
  // restores the open set + active tab.
  const storageKey = useMemo(
    () => persistenceKey(projectTypeId?.id ?? null, roomId),
    [projectTypeId, roomId],
  );
  const [roomTabs, setRoomTabs] = useState<RoomTab[]>(() => readPersistedRoomTabs(storageKey).tabs);
  const [activeRoomTabKey, setActiveRoomTabKey] = useState<string | null>(
    () => readPersistedRoomTabs(storageKey).activeKey,
  );

  // Reload the persisted state whenever we switch into a different scope.
  useEffect(() => {
    const persisted = readPersistedRoomTabs(storageKey);
    setRoomTabs(persisted.tabs);
    setActiveRoomTabKey(persisted.activeKey);
  }, [storageKey]);

  // Persist on every change.
  useEffect(() => {
    writePersistedRoomTabs(storageKey, { tabs: roomTabs, activeKey: activeRoomTabKey });
  }, [storageKey, roomTabs, activeRoomTabKey]);

  const handleOpenRoomTab = useCallback((tab: RoomTab) => {
    setRoomTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]));
    setActiveRoomTabKey(tab.key);
  }, []);

  // Load the deep-linked conversation so we can name the tab after the
  // conversation entity (e.g. Community Assistance sets `name` to the first
  // message). When the entity hasn't loaded yet we open with the derived
  // fallback ("Conversation <short-id>"), then patch the title once it does.
  const pointerConvTypeId = useMemo(
    () => (pointerConversationId ? new TypeId(Conversation.type, pointerConversationId) : null),
    [pointerConversationId],
  );
  const { data: pointerConv } = useEntity<Conversation>(pointerConvTypeId);

  useEffect(() => {
    if (!pointerConversationId) return;
    const key = `conv-${pointerConversationId}`;
    handleOpenRoomTab({
      key,
      type: 'conversation',
      title: deriveConversationTitle(pointerConv ?? ({ id: pointerConversationId } as Conversation)),
      asset_ref: pointerConversationId,
    });
  }, [pointerConversationId, pointerConv, handleOpenRoomTab]);

  // Patch the tab title when the conversation entity finally resolves a name.
  useEffect(() => {
    if (!pointerConversationId || !pointerConv) return;
    const key = `conv-${pointerConversationId}`;
    const nextTitle = deriveConversationTitle(pointerConv);
    setRoomTabs((prev) =>
      prev.map((t) => (t.key === key && t.title !== nextTitle ? { ...t, title: nextTitle } : t)),
    );
  }, [pointerConversationId, pointerConv]);

  const handleRenameRoomTab = useCallback((key: string, newTitle: string) => {
    setRoomTabs((prev) => prev.map((t) => (t.key === key ? { ...t, title: newTitle } : t)));
    // Persist rename to the underlying entity, when applicable. Tab types that
    // aren't first-class entities (e.g. markdown files) only update locally.
    setRoomTabs((prev) => {
      const tab = prev.find((t) => t.key === key);
      if (!tab) return prev;
      if (tab.type === 'conversation') {
        void (async () => {
          try {
            const conv = await Conversation.getById<Conversation>(tab.asset_ref);
            if (conv) {
              conv.name = newTitle;
              await conv.save();
            }
          } catch (err) {
            console.warn('[CollaborationPage] failed to persist conversation rename', err);
          }
        })();
      }
      return prev;
    });
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

  if (!projectTypeId) return <EmptyState />;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ProjectViewHeader project={project} localMemberId={localMemberId} />
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
          <div className="min-h-0 flex-1">
            <RoomTabs
              tabs={roomTabs}
              activeKey={activeRoomTabKey}
              onActivate={setActiveRoomTabKey}
              onClose={handleCloseRoomTab}
              onRename={handleRenameRoomTab}
              className="h-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
