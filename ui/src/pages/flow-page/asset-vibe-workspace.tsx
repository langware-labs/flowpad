import { AgenticProcess, dataContext, fsStore, TypeId, VFSPath } from '@sdk';
import { useAgentContext } from '@src/contexts/agent-context';
import { ViewMode } from '@src/contexts/view-mode-context';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { shellIdFromShowTarget } from '@src/navigation/shell-show-target';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import type { ImperativePanelGroupHandle, ImperativePanelHandle } from 'react-resizable-panels';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContentPanel } from './content-panel/content-panel';
import { WorkspaceChildStrip } from './workspace-child-strip';
import { useProcessSurface } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { VibeChatPane } from './vibe-chat-pane';
import { type VibeWorkspaceSession, useVibeWorkspaceSessionHost } from './use-vibe-workspace-session';
import { assetWorkContextForDock } from './asset-work-context';
import type { DisplayShowTarget } from './display-annotation';
import { useEntityOps } from '@sdk/react/hooks';
import type { IEntity } from '@sdk';

interface AssetVibeWorkspaceProps {
  isVibe: boolean;
  session: VibeWorkspaceSession | null;
}

/**
 * Stable asset/file host. ContentPanel's ancestry never changes; only the
 * sibling chat panel's size and the panel's presentation props do.
 */
export function AssetVibeWorkspace({ isVibe, session }: AssetVibeWorkspaceProps) {
  const { computeNode, project } = useAgentContext();
  const { currentDock, navigation } = useDockNavigation();
  const currentDockRef = useRef(currentDock);
  const navigationRef = useRef(navigation);
  // The process doing the showing IS the host, and it is in scope on the very
  // line that builds a `flow show` destination — stamping it there is what stops
  // the arrival from re-deriving it (and possibly resolving a DIFFERENT process
  // than the one that showed it).
  const hostProcessIdRef = useRef<string | null>(null);
  currentDockRef.current = currentDock;
  navigationRef.current = navigation;
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const hasExpandedChatRef = useRef(isVibe);
  const mountedAtRef = useRef(Date.now());
  const hasObservedLastShownRef = useRef(false);
  const handledLastShownKeyRef = useRef('');
  const [transitionsReady, setTransitionsReady] = useState(false);
  // The session resolves synchronously from the URL + the tab store, so there is
  // no unknown-host window to paper over: no provisional shape, no dual-source
  // process identity, no flushSync.
  const effectiveSession = session;
  const process = useVibeWorkspaceSessionHost(effectiveSession, isVibe);
  // Kept in a ref because `openShownTarget` is deliberately stable (see below):
  // re-creating it would open a cleanup/re-subscribe gap against the process
  // save that lands immediately before `on_show`.
  // The pointer form (`agentic_process-<uuid>`), NOT the bare `processId`: the
  // host is resolved back through `DockPointer.forShell(host)`, so a bare uuid
  // silently matches no tab and the URL-carried host does nothing.
  hostProcessIdRef.current = effectiveSession?.processDock.pointer ?? null;
  // Vibe has no InteractiveTerminal, so this is where the session's transport
  // is kept aligned with the view mode while the workspace is on screen.
  useProcessSurface({ process });

  const resolvedAsset = dataContext.activeEntity as {
    typeId?: TypeId | null;
    name?: string | null;
    filename?: string | null;
    asset_ref?: string | null;
  } | null;
  const dockTypeId = currentDock?.targetTypeId ?? null;
  const dockMachinePath = currentDock?.vfsPath?.machinePath ?? null;
  const resolvedTypeId =
    dockTypeId ??
    (dockMachinePath && resolvedAsset?.asset_ref === dockMachinePath ? (resolvedAsset.typeId ?? null) : null);
  const resolvedLabel =
    resolvedTypeId && resolvedAsset?.typeId?.toString() === resolvedTypeId.toString()
      ? (resolvedAsset.name ?? resolvedAsset.filename ?? null)
      : null;
  const workContext = useMemo(
    () =>
      currentDock && isContentAssetDock(currentDock)
        ? assetWorkContextForDock(currentDock, resolvedTypeId, resolvedLabel)
        : null,
    [currentDock, resolvedLabel, resolvedTypeId],
  );

  useLayoutEffect(() => {
    // react-resizable-panels exposes the imperative handle before its initial
    // layout contains panel sizes. Initial Standard/Vibe sizing comes from the
    // matching defaultSize props below; only later mode changes are imperative.
    if (panelGroupRef.current?.getLayout().length !== 2) return;
    if (isVibe) {
      const chatPanel = chatPanelRef.current;
      if (!chatPanel) return;
      if (hasExpandedChatRef.current) chatPanel.expand();
      else {
        chatPanel.expand(36);
        hasExpandedChatRef.current = true;
      }
    } else {
      chatPanelRef.current?.collapse();
    }
  }, [isVibe]);

  useEffect(() => {
    setTransitionsReady(true);
  }, []);

  // NOTE: there is deliberately no host RE-DERIVATION here any more. A document
  // opened in vibe without a host in its URL is just a document at its natural
  // asset address — the app never infers or invents a workspace for it. What
  // used to live here resolved the project over the network, queried every Chat
  // for one matching the asset, and CREATED a process when none matched, which
  // is why a reload could land on a different process than the one that showed
  // the document. The URL carries the host now (`DockPointer.hostProcessId`).

  const openShownTarget = useCallback((target: DisplayShowTarget) => {
    try {
      const host = hostProcessIdRef.current;
      // A terminal is hosted as a workspace child tab, not opened as an asset
      // — the same path the journey's open_terminal act takes.
      const shellId = shellIdFromShowTarget(target);
      if (shellId) {
        void navigationRef.current.openShell(shellId, { viewMode: ViewMode.Vibe, host: host ?? undefined });
        return;
      }
      const targetDock = dockForDisplayTarget(target);
      if (!targetDock || !isContentAssetDock(targetDock)) return;
      const vibeDock = targetDock.withViewMode(ViewMode.Vibe).withHost(host);
      if (currentDockRef.current?.equals(vibeDock)) return;
      navigationRef.current.openDock(vibeDock);
    } catch (error) {
      console.error('[asset-vibe] failed to open show target', target, error);
    }
  }, []);

  // On a child URL, the parent process remains authoritative. A new asset/file
  // `flow show` is focused by URL and the destination loader materializes it.
  // The callback is stable so the process save emitted immediately before
  // `on_show` cannot create a React cleanup/re-subscribe gap.
  useEffect(() => {
    // ONE process identity now — there is no provisional twin to also subscribe.
    if (!isVibe || !effectiveSession || !process) return;
    return process.onShow(openShownTarget);
  }, [effectiveSession, isVibe, openShownTarget, process]);

  useEffect(() => {
    if (!isVibe || !effectiveSession?.processId) return;
    const manager = dataContext.dataManager;
    // Lightweight unit hosts can render the workspace before the SDK manager
    // is installed. The process-instance listener above remains sufficient in
    // that environment; the manager listener closes the live WS attach race.
    if (!manager) return;
    const processTypeId = `${AgenticProcess.type}-${effectiveSession.processId}`;
    const onEntityEvent = (typeId: TypeId, event: string, payload: Record<string, unknown>) => {
      if (typeId.toString() !== processTypeId || event !== 'on_show') return;
      openShownTarget(payload as DisplayShowTarget);
    };
    manager.on('on_entity_event', onEntityEvent);
    return () => manager.off('on_entity_event', onEntityEvent);
  }, [effectiveSession?.processId, isVibe, openShownTarget]);

  // `on_show` is persisted on the process before the transient entity event is
  // emitted. Consume that ordinary process update directly too: it is the
  // durable delivery seam when a save-triggered render overlaps the transient
  // flow-data frame.
  const processEntityTypes = useMemo(() => [AgenticProcess.type], []);
  const onProcessEntityOp = useCallback(
    (typeId: TypeId, op: 'create' | 'update' | 'delete', data: IEntity) => {
      if (
        !isVibe ||
        !effectiveSession?.processId ||
        typeId.id !== effectiveSession.processId ||
        (op !== 'create' && op !== 'update')
      ) {
        return;
      }
      const shown = (data as IEntity & { context_data?: { last_shown?: DisplayShowTarget } }).context_data?.last_shown;
      if (!shown) return;
      const key = JSON.stringify(shown);
      if (handledLastShownKeyRef.current === key) return;
      handledLastShownKeyRef.current = key;
      openShownTarget(shown);
    },
    [effectiveSession?.processId, isVibe, openShownTarget],
  );
  useEntityOps(processEntityTypes, onProcessEntityOp);

  // `on_show` is persisted before its ephemeral entity event is emitted. Replay
  // that durable pin when a late-mounted client finishes attaching its process
  // listener, closing the small watch-registered → React-effect race.
  const lastShown = (process?.context_data as { last_shown?: DisplayShowTarget } | undefined)?.last_shown;
  const lastShownKey = lastShown ? JSON.stringify(lastShown) : '';
  const displayStack = process?.displayStack ?? [];
  const newestShownAt = displayStack[displayStack.length - 1]?.shown_at;
  const parsedNewestShownAt = newestShownAt ? Date.parse(newestShownAt) : Number.NaN;
  const newestShownAtMs = Number.isFinite(parsedNewestShownAt) ? parsedNewestShownAt : null;
  useEffect(() => {
    if (!isVibe || !effectiveSession || !lastShown) return;
    if (!hasObservedLastShownRef.current) {
      hasObservedLastShownRef.current = true;
      // The URL that mounted this workspace is authoritative. Persisted show
      // state older than the mount is a baseline (for example an explicit
      // history selection), not a fresh navigation command. A show written
      // after mount is the late-listener race this durable replay exists for.
      if (newestShownAtMs === null || newestShownAtMs < mountedAtRef.current) {
        handledLastShownKeyRef.current = lastShownKey;
        return;
      }
    }
    if (handledLastShownKeyRef.current === lastShownKey) return;
    handledLastShownKeyRef.current = lastShownKey;
    openShownTarget(lastShown);
  }, [effectiveSession, isVibe, lastShownKey, newestShownAtMs, openShownTarget]);

  // Bridge live worker writes into the canonical FS invalidation channel. The
  // store keeps dirty cache entries, so this refreshes clean viewers without
  // clobbering an unsaved editor buffer.
  useEffect(() => {
    const computeNodeTypeId = computeNode?.typeId;
    if (!process || !computeNodeTypeId) return;
    return process.on('entity_event', (event: string, payload: Record<string, unknown>) => {
      if (event !== 'file.write' || typeof payload.path !== 'string' || !payload.path) return;
      const parsed = VFSPath.parse(payload.path);
      const path = parsed.isAbsolute
        ? parsed.entitySubPath
        : payload.path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(payload.path)
          ? VFSPath.fromMachinePath(payload.path, computeNodeTypeId).entitySubPath
          : payload.path;
      fsStore.getState().invalidate(computeNodeTypeId, path, 'all');
    });
  }, [computeNode?.typeId, process]);

  const transitionClass = transitionsReady
    ? 'transition-[flex-grow] [transition-duration:280ms] ease-out motion-reduce:transition-none'
    : '';

  return (
    <ResizablePanelGroup ref={panelGroupRef} direction="horizontal" className="h-full w-full">
      <ResizablePanel
        ref={chatPanelRef}
        id="asset-vibe-chat"
        order={1}
        defaultSize={isVibe ? 36 : 0}
        minSize={24}
        maxSize={55}
        collapsible
        collapsedSize={0}
        className={transitionClass}
      >
        <div
          aria-hidden={!isVibe}
          className={[
            'h-full',
            transitionsReady
              ? 'transition-[opacity,transform] ease-out [transition-duration:280ms] motion-reduce:transition-none'
              : '',
            isVibe ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-1 opacity-0',
          ].join(' ')}
        >
          {isVibe ? <VibeChatPane process={process} workContext={workContext} /> : null}
        </div>
      </ResizablePanel>
      <ResizableHandle
        withHandle
        disabled={!isVibe}
        tabIndex={isVibe ? 0 : -1}
        aria-hidden={!isVibe}
        className={[
          transitionsReady ? 'transition-opacity [transition-duration:280ms] motion-reduce:transition-none' : '',
          isVibe ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      />
      <ResizablePanel id="asset-vibe-content" order={2} defaultSize={isVibe ? 64 : 100} minSize={45}>
        <div className="flex h-full flex-col">
          <div className={isVibe ? 'block' : 'hidden'}>
            {effectiveSession ? (
              <WorkspaceChildStrip
                processTab={effectiveSession.processTab}
                processDock={effectiveSession.processDock}
                projectId={project?.id ?? null}
              />
            ) : (
              <div
                data-testid="workspace-child-strip"
                aria-busy="true"
                className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-2"
              >
                <span className="h-4 w-8 animate-pulse rounded bg-muted-foreground/15" />
                <span className="h-4 w-24 animate-pulse rounded bg-muted-foreground/10" />
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <ContentPanel minimalChrome={isVibe} />
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
