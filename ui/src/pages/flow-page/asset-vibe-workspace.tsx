import { AgenticProcess, dataContext, fsStore, TypeId, VFSPath } from '@sdk';
import { useAgentContext } from '@src/contexts/agent-context';
import { ViewMode } from '@src/contexts/view-mode-context';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { shellIdFromShowTarget } from '@src/navigation/shell-show-target';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@src/components/ui/resizable';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ContentPanel } from './content-panel/content-panel';
import { WorkspaceChildStrip } from './workspace-child-strip';
import { useProcessSurface } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { VibeChatPane } from './vibe-chat-pane';
import {
  type VibeWorkspaceSession,
  useVibeWorkspaceSessionHost,
} from './use-vibe-workspace-session';
import { assetWorkContextForDock } from './asset-work-context';
import type { DisplayShowTarget } from './display-annotation';
import { setupTabAndAdopt } from '@src/tabs/setup-tab-and-adopt';
import {
  ensureAssetVibeParentTab,
  resolveAssetVibeHost,
} from '@src/tabs/vibe-parent';
import { useEntityOps } from '@sdk/react/hooks';
import type { IEntity } from '@sdk';

interface AssetVibeWorkspaceProps {
  isVibe: boolean;
  session: VibeWorkspaceSession | null;
}

/** Asset/file show targets only — a `shell` target is handled before this. */
function dockForShowTarget(target: DisplayShowTarget) {
  const editor = target.type ? editorForType(target.type) : undefined;
  if (editor && target.typeid) {
    return AssetDocPointer.forTypeId(editor, new TypeId(target.typeid)).toDockPointer();
  }
  return target.path ? dockPointerForFile(target.path) : null;
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
  currentDockRef.current = currentDock;
  navigationRef.current = navigation;
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const handledLastShownKeyRef = useRef('');
  const [transitionsReady, setTransitionsReady] = useState(false);
  const [provisionalSession, setProvisionalSession] = useState<{
    dockKey: string;
    session: VibeWorkspaceSession;
    process: AgenticProcess;
  } | null>(null);
  const matchingProvisionalSession =
    currentDock?.tabHash &&
    provisionalSession?.dockKey === currentDock.tabHash
      ? provisionalSession.session
      : null;
  // Render the chat as soon as the exact target-keyed process resolves. Tab
  // materialization and child adoption continue behind it and replace this
  // provisional shape through the all-tabs store when complete.
  const effectiveSession = session ?? matchingProvisionalSession;
  const watchedProcess = useVibeWorkspaceSessionHost(effectiveSession, isVibe);
  const provisionalProcess =
    provisionalSession?.dockKey === currentDock?.tabHash
      ? provisionalSession.process
      : null;
  const process = watchedProcess ?? provisionalProcess;
  // Vibe has no InteractiveTerminal, so this is where the session's transport
  // is kept aligned with the view mode while the workspace is on screen.
  useProcessSurface({ process });


  const resolvedAsset = dataContext.activeEntity as
    | {
        typeId?: TypeId | null;
        name?: string | null;
        filename?: string | null;
        asset_ref?: string | null;
      }
    | null;
  const dockTypeId = currentDock?.targetTypeId ?? null;
  const dockMachinePath = currentDock?.vfsPath?.machinePath ?? null;
  const resolvedTypeId =
    dockTypeId ??
    (dockMachinePath && resolvedAsset?.asset_ref === dockMachinePath
      ? (resolvedAsset.typeId ?? null)
      : null);
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
    if (isVibe) chatPanelRef.current?.expand();
    else chatPanelRef.current?.collapse();
  }, [isVibe]);

  useEffect(() => {
    setTransitionsReady(true);
  }, []);

  // Session/process attachment is a mounted-view side effect, not a route
  // loader dependency. This keeps URL → loader → asset render fast, then
  // adopts the already-visible asset under its exact target-keyed Chat through
  // the canonical tab seam.
  useEffect(() => {
    if (!isVibe || session || !currentDock || !isContentAssetDock(currentDock)) return;
    let cancelled = false;
    const dockKey = currentDock.tabHash;
    void resolveAssetVibeHost(currentDock).then(async (host) => {
      if (cancelled || !host || !dockKey) return;
      // Commit the resolved chat before starting process-tab materialization.
      // That request may queue behind other boot traffic; it must not hold the
      // visible Standard → Vibe morph or chat controls behind it.
      flushSync(() => {
        setProvisionalSession({
          dockKey,
          process: host.process,
          session: {
            processTab: null,
            processDock: new DockPointer(host.process.terminalDockPointer),
            processId: host.process.id,
            onProcessUrl: false,
          },
        });
      });
      const processTab = await ensureAssetVibeParentTab(host);
      if (cancelled || !processTab) return;
      setProvisionalSession({
        dockKey,
        process: host.process,
        session: {
          processTab,
          processDock: new DockPointer(host.process.terminalDockPointer),
          processId: host.process.id,
          onProcessUrl: false,
        },
      });
      await setupTabAndAdopt(currentDock, { parentTabId: processTab.id });
    });
    return () => {
      cancelled = true;
    };
  }, [currentDock, isVibe, session]);

  const openShownTarget = useCallback(
    (target: DisplayShowTarget) => {
      try {
        // A terminal is hosted as a workspace child tab, not opened as an asset
        // — the same path the journey's open_terminal act takes.
        const shellId = shellIdFromShowTarget(target);
        if (shellId) {
          void navigationRef.current.openShell(shellId, { viewMode: ViewMode.Vibe });
          return;
        }
        const targetDock = dockForShowTarget(target);
        if (!targetDock || !isContentAssetDock(targetDock)) return;
        const vibeDock = targetDock.withViewMode(ViewMode.Vibe);
        if (currentDockRef.current?.equals(vibeDock)) return;
        navigationRef.current.openDock(vibeDock);
      } catch (error) {
        console.error('[asset-vibe] failed to open show target', target, error);
      }
    },
    [],
  );

  // On a child URL, the parent process remains authoritative. A new asset/file
  // `flow show` is focused by URL and the destination loader materializes it.
  // The callback is stable so the process save emitted immediately before
  // `on_show` cannot create a React cleanup/re-subscribe gap.
  useEffect(() => {
    if (!isVibe || !effectiveSession) return;
    const candidates = [...new Set([watchedProcess, provisionalProcess].filter(Boolean))];
    const unsubscribes = candidates.map((candidate) =>
      candidate!.onShow(openShownTarget),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [
    effectiveSession,
    isVibe,
    openShownTarget,
    provisionalProcess,
    watchedProcess,
  ]);

  useEffect(() => {
    if (!isVibe || !effectiveSession?.processId) return;
    const manager = dataContext.dataManager;
    // Lightweight unit hosts can render the workspace before the SDK manager
    // is installed. The process-instance listener above remains sufficient in
    // that environment; the manager listener closes the live WS attach race.
    if (!manager) return;
    const processTypeId = `${AgenticProcess.type}-${effectiveSession.processId}`;
    const onEntityEvent = (
      typeId: TypeId,
      event: string,
      payload: Record<string, unknown>,
    ) => {
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
      const shown = (
        data as IEntity & { context_data?: { last_shown?: DisplayShowTarget } }
      ).context_data?.last_shown;
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
  const lastShown = (
    (watchedProcess?.context_data ?? provisionalProcess?.context_data) as
      | { last_shown?: DisplayShowTarget }
      | undefined
  )?.last_shown;
  const lastShownKey = lastShown ? JSON.stringify(lastShown) : '';
  useEffect(() => {
    if (!isVibe || !effectiveSession || !lastShown) return;
    if (handledLastShownKeyRef.current === lastShownKey) return;
    handledLastShownKeyRef.current = lastShownKey;
    openShownTarget(lastShown);
  }, [effectiveSession, isVibe, lastShownKey, openShownTarget]);

  // Bridge live worker writes into the canonical FS invalidation channel. The
  // store keeps dirty cache entries, so this refreshes clean viewers without
  // clobbering an unsaved editor buffer.
  useEffect(() => {
    const computeNodeTypeId = computeNode?.typeId;
    if (!process || !computeNodeTypeId) return;
    return process.on(
      'entity_event',
      (event: string, payload: Record<string, unknown>) => {
        if (event !== 'file.write' || typeof payload.path !== 'string' || !payload.path) return;
        const parsed = VFSPath.parse(payload.path);
        const path = parsed.isAbsolute
          ? parsed.entitySubPath
          : payload.path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(payload.path)
            ? VFSPath.fromMachinePath(payload.path, computeNodeTypeId).entitySubPath
            : payload.path;
        fsStore.getState().invalidate(computeNodeTypeId, path, 'all');
      },
    );
  }, [computeNode?.typeId, process]);

  const transitionClass = transitionsReady
    ? 'transition-[flex-grow] [transition-duration:280ms] ease-out motion-reduce:transition-none'
    : '';

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel
        ref={chatPanelRef}
        id="asset-vibe-chat"
        order={1}
        defaultSize={36}
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
              ? 'transition-[opacity,transform] [transition-duration:280ms] ease-out motion-reduce:transition-none'
              : '',
            isVibe
              ? 'translate-x-0 opacity-100'
              : 'pointer-events-none -translate-x-1 opacity-0',
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
          transitionsReady
            ? 'transition-opacity [transition-duration:280ms] motion-reduce:transition-none'
            : '',
          isVibe ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      />
      <ResizablePanel id="asset-vibe-content" order={2} defaultSize={64} minSize={45}>
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
