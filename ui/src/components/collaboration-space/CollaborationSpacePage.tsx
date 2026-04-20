import {
  AgenticProcess,
  CollaborationSession,
  CollaborationSpace,
  dataContext,
  dataManager,
  getOrCreateLocalMemberId,
  Shell,
  TypeId,
  ViewType,
} from '@sdk';
import type { TerminalTab } from '@src/hooks/useActiveTerminals';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer, getProcessSpaceDockPointer } from '@src/navigation/DockPointer';
import { TabbedTerminal } from '@src/components/terminal';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollaborationSpaceHeader } from './CollaborationSpaceHeader';
import { CollaborationSpaceSidebar } from './CollaborationSpaceSidebar';
import { CollaborationSpaceChat } from './CollaborationSpaceChat';
import { SessionHeader } from './SessionHeader';
import { StartSpaceDialog } from './StartSpaceDialog';

const HEARTBEAT_INTERVAL_MS = 15_000;

function EmptyState() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <Users className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <div className="text-lg font-semibold">No space open</div>
        <div className="text-sm text-muted-foreground">
          Meet collaborators in a space to assist and get assisted.
        </div>
      </div>
      <Button onClick={() => setDialogOpen(true)}>Start a space</Button>
      <StartSpaceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

export function CollaborationSpacePage() {
  const { currentDock, navigation } = useDockNavigation();
  const { toast } = useToast();
  // MRU stack of shell ids within the current session — most-recent first.
  const mruRef = useRef<string[]>([]);

  const isActiveView = currentDock?.viewType === ViewType.COLLABORATION_SPACE;
  const { spaceId, sessionId, tabTypeId } = useMemo(
    () =>
      isActiveView
        ? DockPointer.parseCollaborationSpacePointer(currentDock?.pointer)
        : { spaceId: null, sessionId: null, tabTypeId: null },
    [isActiveView, currentDock?.pointer],
  );

  const spaceTypeId = useMemo(() => {
    if (!spaceId) return null;
    try {
      return new TypeId(CollaborationSpace.type, spaceId);
    } catch {
      return null;
    }
  }, [spaceId]);

  const sessionTypeId = useMemo(() => {
    if (!sessionId) return null;
    try {
      return new TypeId(CollaborationSession.type, sessionId);
    } catch {
      return null;
    }
  }, [sessionId]);

  const { data: space } = useEntity<CollaborationSpace>(spaceTypeId, { watch: true });
  const { data: session } = useEntity<CollaborationSession>(sessionTypeId, { watch: true });
  const localMemberId = useMemo(() => (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : null), []);

  // Resolve the tab TypeId into an active shell id so TabbedTerminal can light
  // up the right tab. For agentic_process, look up the linked shell.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tabTypeId) return;
      if (tabTypeId.type === 'shell') {
        dataContext.setActiveShellId(tabTypeId.id);
        return;
      }
      if (tabTypeId.type === 'agentic_process') {
        try {
          const proc = await dataManager.getByTypeId<{ shell_id?: string | null }>(
            new TypeId('agentic_process', tabTypeId.id),
          );
          if (cancelled) return;
          const shellId = (proc as { shell_id?: string | null } | null)?.shell_id ?? null;
          if (shellId) dataContext.setActiveShellId(shellId);
        } catch (err) {
          console.warn('[CollaborationSpacePage] failed to resolve process shell_id', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabTypeId?.type, tabTypeId?.id]);

  // Heartbeat into the session (not the space) — sessions are the meetings.
  useEffect(() => {
    if (!session || !localMemberId) return;
    let stopped = false;
    const beat = async () => {
      if (stopped) return;
      try {
        await session.heartbeat(localMemberId);
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
  }, [session, localMemberId]);

  // ── Session bootstrap (auto-create when first tab opens without one) ─────
  const ensureSessionForTabOpen = useCallback(async (): Promise<CollaborationSession | null> => {
    if (session) return session;
    if (!space) return null;
    try {
      const fresh = await CollaborationSession.create({
        spaceId: space.id,
        projectId: space.project_id ?? undefined,
        hostName: space.host_name ?? 'Host',
        hostMemberId: localMemberId ?? undefined,
      });
      return fresh;
    } catch (err) {
      console.warn('[CollaborationSpacePage] failed to auto-create session', err);
      return null;
    }
  }, [session, space, localMemberId]);

  // ── Tab event handlers ──────────────────────────────────────────────────
  const touchMru = useCallback((shellId: string) => {
    mruRef.current = [shellId, ...mruRef.current.filter((id) => id !== shellId)];
  }, []);

  const handleTabClick = useCallback(
    (shellId: string, tab: TerminalTab) => {
      if (!spaceId || !sessionId) return;
      touchMru(shellId);
      navigation.openDock(getProcessSpaceDockPointer(tab, spaceId, sessionId));
    },
    [navigation, spaceId, sessionId, touchMru],
  );

  const handleTabClose = useCallback(
    (shellId: string) => {
      if (!spaceId) return;
      mruRef.current = mruRef.current.filter((id) => id !== shellId);
      if (!mruRef.current[0]) {
        // Fall back to the session root (or space root if no session).
        navigation.openDock(
          sessionId
            ? DockPointer.forCollaborationSpace(spaceId, { sessionId })
            : DockPointer.forCollaborationSpace(spaceId),
        );
      }
    },
    [navigation, spaceId, sessionId],
  );

  const handleTabOpen = useCallback(
    async (tab: TerminalTab) => {
      if (!space) return;
      // If a tab is opened before any session exists, start one on the fly.
      let activeSession = session;
      if (!activeSession) {
        activeSession = await ensureSessionForTabOpen();
        if (!activeSession) return;
      }

      // For Claude: the collaboration_space route has no loader that bootstraps
      // proc.start(), so we kick it off here to get a Shell.
      const proc = tab.agenticProcess;
      let shell = tab.shell ?? null;
      if (proc && !shell?.id) {
        try {
          const live =
            AgenticProcess.getByIdFromCache<AgenticProcess>(proc.id) ??
            (await AgenticProcess.getById<AgenticProcess>(proc.id));
          if (live) {
            await live.start({ visible: true });
            if (live.shell_id) {
              shell =
                Shell.getByIdFromCache<Shell>(live.shell_id) ??
                (await Shell.getById<Shell>(live.shell_id)) ??
                null;
            }
          }
        } catch (err) {
          console.warn('[CollaborationSpacePage] failed to start claude process in space', err);
        }
      }

      // Tag the shell with the owning space so the TabbedTerminal filter keeps it.
      if (shell && shell.collaboration_space_id !== space.id) {
        try {
          shell.collaboration_space_id = space.id;
          await shell.save();
        } catch (err) {
          console.warn('[CollaborationSpacePage] failed to tag shell with space id', err);
        }
      }

      // Bind process ↔ session so membership is queryable from either side.
      if (proc?.id) {
        try {
          const live =
            AgenticProcess.getByIdFromCache<AgenticProcess>(proc.id) ??
            (await AgenticProcess.getById<AgenticProcess>(proc.id));
          if (live && live.collaboration_session_id !== activeSession.id) {
            live.collaboration_session_id = activeSession.id;
            await live.save();
          }
          await activeSession.addProcess(proc.id);
        } catch (err) {
          console.warn('[CollaborationSpacePage] failed to bind process to session', err);
        }
      }

      const enriched: TerminalTab = { ...tab, shell: shell ?? tab.shell };
      touchMru(enriched.shellId);
      navigation.openDock(getProcessSpaceDockPointer(enriched, space.id, activeSession.id));
    },
    [navigation, space, session, ensureSessionForTabOpen, touchMru],
  );

  if (!spaceId) return <EmptyState />;
  if (!space) {
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
    try {
      const shell = Shell.getByIdFromCache(activeShellId) ?? (await Shell.getById(activeShellId));
      if (!shell) return;
      shell.collaboration_space_id = space.id;
      await shell.save();
      toast({ title: 'Shared to space', description: shell.name ?? 'Tab shared.' });
    } catch (err) {
      console.error('[CollaborationSpacePage] share failed', err);
      toast({ title: 'Share failed', description: String((err as Error).message ?? err) });
    }
  };

  const isHost = space.isHost(localMemberId ?? undefined);

  return (
    <div className="flex h-full flex-col">
      <CollaborationSpaceHeader space={space} localMemberId={localMemberId} />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 flex-shrink-0 overflow-y-auto border-r">
          <CollaborationSpaceSidebar />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {session && <SessionHeader session={session} isHost={session.isHost(localMemberId ?? undefined)} />}
          {isHost && (
            <div className="flex h-9 flex-shrink-0 items-center justify-end gap-2 border-b bg-muted/30 px-3 text-xs">
              <span className="text-muted-foreground">Host controls:</span>
              <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void handleShareActiveTab()}>
                Share active tab into space
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={60} minSize={20}>
                <TabbedTerminal
                  className="h-full"
                  collaborationSpaceId={space.id}
                  addTabButton
                  onTabClick={handleTabClick}
                  onTabClose={handleTabClose}
                  onTabOpen={handleTabOpen}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={40} minSize={20}>
                <CollaborationSpaceChat />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
