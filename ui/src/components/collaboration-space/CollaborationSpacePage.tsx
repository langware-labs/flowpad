import { CollaborationSpace, dataContext, dataManager, getOrCreateLocalMemberId, Shell, TypeId, ViewType } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { TabbedTerminal } from '@src/components/terminal';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
  const { currentDock } = useDockNavigation();
  const { toast } = useToast();

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
                <TabbedTerminal className="h-full" collaborationSpaceId={space.id} addTabButton />
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
