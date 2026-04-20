import { AgenticProcess, CollaborationSpace, dataContext, dataManager, getOrCreateLocalMemberId, Shell, TypeId, ViewType } from '@sdk';
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
  // MRU stack of shell ids — most-recent first, maintained from onTabClick.
  const mruRef = useRef<string[]>([]);

  // Content-panel keeps every <TabsContent> mounted and hides the inactive ones,
  // so this page still runs while the user is on a different viewType. Treat
  // any non-collaboration_space currentDock as "no pointer" so we don't try to
  // parse a shell TypeId as a space id.
  const isActiveView = currentDock?.viewType === ViewType.COLLABORATION_SPACE;
  const { spaceId, sub } = useMemo(
    () =>
      isActiveView
        ? DockPointer.parseCollaborationSpacePointer(currentDock?.pointer)
        : { spaceId: null, sub: null },
    [isActiveView, currentDock?.pointer],
  );

  const typeId = useMemo(() => {
    if (!spaceId) return null;
    try {
      return new TypeId(CollaborationSpace.type, spaceId);
    } catch {
      return null;
    }
  }, [spaceId]);

  const { data: space } = useEntity<CollaborationSpace>(typeId, { watch: true });
  const localMemberId = useMemo(() => (typeof window !== 'undefined' ? getOrCreateLocalMemberId() : null), []);

  // Resolve sub-entity reference into an active shell id so the nested
  // TabbedTerminal lights up the right tab. For agentic_process, look up the
  // linked shell via the process entity.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sub) return;
      if (sub.type === 'shell') {
        dataContext.setActiveShellId(sub.id);
        return;
      }
      if (sub.type === 'agentic_process') {
        try {
          const proc = await dataManager.getByTypeId<{ shell_id?: string | null }>(
            new TypeId('agentic_process', sub.id),
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
  }, [sub?.type, sub?.id]);

  useEffect(() => {
    if (!space || !localMemberId) return;
    let stopped = false;
    const beat = async () => {
      if (stopped) return;
      try {
        await space.heartbeat(localMemberId);
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
  }, [space, localMemberId]);

  // ── Tab event handlers for the nested TabbedTerminal ────────────────────
  // Declared before any early return so hook order stays stable regardless of
  // whether `space` is still loading.
  const spaceIdForHandlers = space?.id ?? null;

  const touchMru = useCallback((shellId: string) => {
    mruRef.current = [shellId, ...mruRef.current.filter((id) => id !== shellId)];
  }, []);

  const handleTabClick = useCallback(
    (shellId: string, session: TerminalTab) => {
      if (!spaceIdForHandlers) return;
      touchMru(shellId);
      navigation.openDock(getProcessSpaceDockPointer(session, spaceIdForHandlers));
    },
    [navigation, spaceIdForHandlers, touchMru],
  );

  const handleTabClose = useCallback(
    (shellId: string) => {
      if (!spaceIdForHandlers) return;
      mruRef.current = mruRef.current.filter((id) => id !== shellId);
      // Stay inside the space. If nothing's left in MRU, land on the space
      // root (empty TabbedTerminal). If something's left, let the loader pick
      // up the next default; the URL already stays scoped.
      if (!mruRef.current[0]) {
        navigation.openDock(DockPointer.forCollaborationSpace(spaceIdForHandlers));
      }
    },
    [navigation, spaceIdForHandlers],
  );

  const handleTabOpen = useCallback(
    async (session: TerminalTab) => {
      const currentSpace = space;
      if (!currentSpace) return;
      // For Claude: the space route has no loader that calls process.start().
      // We bootstrap here so the Shell gets created and picked up by the
      // TabbedTerminal's space-scoped filter.
      const proc = session.agenticProcess;
      let shell = session.shell ?? null;

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

      // Tag the shell so the space-scoped `useActiveTerminals` filter matches.
      if (shell && shell.collaboration_space_id !== currentSpace.id) {
        try {
          shell.collaboration_space_id = currentSpace.id;
          await shell.save();
        } catch (err) {
          console.warn('[CollaborationSpacePage] failed to tag shell with space id', err);
        }
      }

      // Bind the agentic_process to the space (mostly cosmetic — gives the
      // space a canonical "current process" reference).
      if (proc?.id && currentSpace.agentic_process_id !== proc.id) {
        try {
          currentSpace.agentic_process_id = proc.id;
          await currentSpace.save();
        } catch (err) {
          console.warn('[CollaborationSpacePage] failed to bind process to space', err);
        }
      }

      const enriched: TerminalTab = { ...session, shell: shell ?? session.shell };
      touchMru(enriched.shellId);
      navigation.openDock(getProcessSpaceDockPointer(enriched, currentSpace.id));
    },
    [navigation, space, touchMru],
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
