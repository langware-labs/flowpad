import {
  AgenticProcess,
  CollaborationSession,
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
import { DockPointer, getProcessCollaborationDockPointer } from '@src/navigation/DockPointer';
import { TabbedTerminal } from '@src/components/terminal';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollaborationHeader } from './CollaborationHeader';
import { CollaborationSidebar } from './CollaborationSidebar';
import { CollaborationChat } from './CollaborationChat';
import { SessionHeader } from './SessionHeader';
import { StartCollaborationDialog } from './StartCollaborationDialog';

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
      <StartCollaborationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

export function CollaborationPage() {
  const { currentDock, navigation } = useDockNavigation();
  const { toast } = useToast();
  // MRU stack of shell ids within the current session — most-recent first.
  const mruRef = useRef<string[]>([]);

  const isActiveView = currentDock?.viewType === ViewType.COLLABORATION;
  const { projectId, sessionId, tabTypeId } = useMemo(
    () =>
      isActiveView
        ? DockPointer.parseCollaborationPointer(currentDock?.pointer)
        : { projectId: null, sessionId: null, tabTypeId: null },
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

  const sessionTypeId = useMemo(() => {
    if (!sessionId) return null;
    try {
      return new TypeId(CollaborationSession.type, sessionId);
    } catch {
      return null;
    }
  }, [sessionId]);

  const { data: project } = useEntity<Project>(projectTypeId, { watch: true });
  const { data: session } = useEntity<CollaborationSession>(sessionTypeId, { watch: true });
  const localMemberId = useMemo(() => (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : null), []);

  // Heartbeat into the session — sessions are the meetings.
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
    if (!project) return null;
    try {
      const fresh = await CollaborationSession.create({
        projectId: project.id,
        hostName: project.displayName || 'Host',
        hostMemberId: localMemberId ?? undefined,
      });
      return fresh;
    } catch (err) {
      console.warn('[CollaborationPage] failed to auto-create session', err);
      return null;
    }
  }, [session, project, localMemberId]);

  // ── Tab event handlers ──────────────────────────────────────────────────
  const touchMru = useCallback((shellId: string) => {
    mruRef.current = [shellId, ...mruRef.current.filter((id) => id !== shellId)];
  }, []);

  const handleTabClick = useCallback(
    (shellId: string, tab: TerminalTab) => {
      if (!projectId || !sessionId) return;
      touchMru(shellId);
      navigation.openDock(getProcessCollaborationDockPointer(tab, projectId, sessionId));
    },
    [navigation, projectId, sessionId, touchMru],
  );

  const handleTabClose = useCallback(
    (shellId: string) => {
      if (!projectId) return;
      mruRef.current = mruRef.current.filter((id) => id !== shellId);
      if (!mruRef.current[0]) {
        navigation.openDock(
          sessionId
            ? DockPointer.forCollaboration(projectId, { sessionId })
            : DockPointer.forCollaboration(projectId),
        );
      }
    },
    [navigation, projectId, sessionId],
  );

  const handleTabOpen = useCallback(
    async (tab: TerminalTab) => {
      if (!project) return;
      // If a tab is opened before any session exists, start one on the fly.
      let activeSession = session;
      if (!activeSession) {
        activeSession = await ensureSessionForTabOpen();
        if (!activeSession) return;
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
      if (shell && shell.collaboration_session_id !== activeSession.id) {
        try {
          shell.collaboration_session_id = activeSession.id;
          await shell.save();
        } catch (err) {
          console.warn('[CollaborationPage] failed to tag shell with session id', err);
        }
      }

      // Bind process ↔ session so membership is queryable from either side.
      if (proc?.id) {
        try {
          const live =
            AgenticProcess.getByIdFromCache<AgenticProcess>(proc.id) ??
            (await AgenticProcess.getById<AgenticProcess>(proc.id).catch(() => null));
          if (live && live.collaboration_session_id !== activeSession.id) {
            live.collaboration_session_id = activeSession.id;
            await live.save();
          }
          await activeSession.addProcess(proc.id);
        } catch (err) {
          console.warn('[CollaborationPage] failed to bind process to session', err);
        }
      }

      const enriched: TerminalTab = { ...tab, shell: shell ?? tab.shell };
      touchMru(enriched.shellId);
      navigation.openDock(getProcessCollaborationDockPointer(enriched, project.id, activeSession.id));
    },
    [navigation, project, session, ensureSessionForTabOpen, touchMru],
  );

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
    if (!session) {
      toast({ title: 'No active session', description: 'Start a session first.' });
      return;
    }
    try {
      const shell = Shell.getByIdFromCache(activeShellId) ?? (await Shell.getById(activeShellId));
      if (!shell) return;
      shell.collaboration_session_id = session.id;
      await shell.save();
      toast({ title: 'Shared to session', description: shell.name ?? 'Tab shared.' });
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
          <CollaborationSidebar projectId={project.id} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {session && <SessionHeader session={session} isHost={session.isHost(localMemberId ?? undefined)} />}
          {isHost && (
            <div className="flex h-9 flex-shrink-0 items-center justify-end gap-2 border-b bg-muted/30 px-3 text-xs">
              <span className="text-muted-foreground">Host controls:</span>
              <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void handleShareActiveTab()}>
                Share active tab into session
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={60} minSize={20}>
                <TabbedTerminal
                  className="h-full"
                  collaborationSessionId={session?.id ?? null}
                  spawnProjectId={project.id}
                  addTabButton
                  onTabClick={handleTabClick}
                  onTabClose={handleTabClose}
                  onTabOpen={handleTabOpen}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={40} minSize={20}>
                <CollaborationChat />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
