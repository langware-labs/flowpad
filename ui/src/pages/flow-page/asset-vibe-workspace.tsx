import { dataContext, fsStore, TypeId, VFSPath } from '@sdk';
import { useAgentContext } from '@src/contexts/agent-context';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import { openActiveDisplay } from '@src/navigation/open-active-display';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import type { ImperativePanelGroupHandle, ImperativePanelHandle } from 'react-resizable-panels';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContentPanel } from './content-panel/content-panel';
import { DisplayChrome } from './display-chrome';
import { WorkspaceChildStrip } from './workspace-child-strip';
import { useProcessSurface } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { VibeChatPane } from './vibe-chat-pane';
import { type VibeWorkspaceSession, useVibeWorkspaceSessionHost } from './use-vibe-workspace-session';
import { assetWorkContextForDock } from './asset-work-context';
import type { DisplayShowTarget } from './display-annotation';

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
  const projectIdRef = useRef<string | null>(null);
  currentDockRef.current = currentDock;
  navigationRef.current = navigation;
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const hasExpandedChatRef = useRef(isVibe);
  const [transitionsReady, setTransitionsReady] = useState(false);
  // The session resolves synchronously from the URL plus the tab store, so there
  // is no unknown-host window to paper over and one process identity throughout.
  const process = useVibeWorkspaceSessionHost(session, isVibe);
  // Kept in a ref because `openShownTarget` is deliberately stable (see below):
  // re-creating it would open a cleanup/re-subscribe gap against the process
  // save that lands immediately before `on_show`.
  // The pointer form (`agentic_process-<uuid>`), NOT the bare `processId`: the
  // host is resolved back through `DockPointer.forShell(host)`, so a bare uuid
  // silently matches no tab and the URL-carried host does nothing.
  hostProcessIdRef.current = session?.processDock.pointer ?? null;
  projectIdRef.current = project?.id ?? null;
  // Vibe has no InteractiveTerminal, so this is where the session's transport
  // is kept aligned with the view mode while the workspace is on screen. It also
  // hands back the REACTIVE entity — which is what the display chrome reads for
  // the history stack, so the popover stays in step with `context_data` broadcasts
  // instead of whatever `context_data` happened to be when the session resolved.
  const persistedProcess = useProcessSurface({ process });

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

  // A document whose URL names no host is just a document at its natural asset
  // address: nothing here infers or invents a workspace for it. Host identity
  // arrives with the URL (`DockPointer.hostProcessId`).

  // The FIRST show after a mount pushes; every one after it replaces. With pure
  // replace the first show would overwrite the URL the user arrived on, so Back
  // would eject them from the workspace instead of returning them to it. After
  // that, replacing is what keeps a chatty agent from burying the user's own
  // history — the show history stays browsable in the display popover.
  const hasPushedDisplayRef = useRef(false);
  // Bumped on EVERY show, before the navigation decision. Two jobs, both real:
  //
  //  - it is the render trigger. The SDK mutates cached entities IN PLACE, so a
  //    new `display_stack` arrives behind a referentially identical object and
  //    React never re-renders — the history popover would sit frozen at whatever
  //    it read first. The old pane got this for free because every show called
  //    `setShown`; navigating alone does not.
  //  - it is the cache-buster. A re-show of the SAME target is a no-op
  //    navigation, yet the file behind it may have been rebuilt, and the iframe
  //    registry keys by `src`.
  const [showNonce, setShowNonce] = useState(0);
  // The payload of the newest show — see `DisplayChrome.latestShown`.
  const [latestShown, setLatestShown] = useState<DisplayShowTarget | null>(null);

  const openShownTarget = useCallback((target: DisplayShowTarget) => {
    try {
      setShowNonce((n) => n + 1);
      setLatestShown(target);
      const pushed = hasPushedDisplayRef.current;
      const committed = openActiveDisplay({
        target,
        navigation: navigationRef.current,
        host: hostProcessIdRef.current,
        projectId: projectIdRef.current,
        currentDock: currentDockRef.current,
        push: !pushed,
      });
      if (committed) hasPushedDisplayRef.current = true;
    } catch (error) {
      console.error('[asset-vibe] failed to open show target', target, error);
    }
  }, []);

  // On a child URL, the parent process remains authoritative. A new asset/file
  // `flow show` is focused by URL and the destination loader materializes it.
  // The callback is stable so the process save emitted immediately before
  // `on_show` cannot create a React cleanup/re-subscribe gap.
  useEffect(() => {
    if (!isVibe || !session || !process) return;
    return process.onShow(openShownTarget);
  }, [session, isVibe, openShownTarget, process]);

  // A SECOND live `on_show` channel used to be declared here, subscribing to the
  // DataManager to "close the live WS attach race". It never ran once: it read
  // `dataContext.dataManager`, which does not exist on DataContext, so its
  // `if (!manager) return;` guard always fired.
  //
  // Deleted rather than repaired, because the note below already retired the
  // job it was written for: restore is the loader's (`routeProcessPointer`),
  // and the `process.onShow` subscription above is — in that note's words — the
  // only channel left. Reviving it would have added a duplicate handler that
  // double-bumps `showNonce`, reloading the iframe an extra time per show.

  // The durable `last_shown` replay that used to live here is GONE, along with the
  // `useEntityOps` channel and the mount-time baseline that arbitrated between them.
  //
  // Those existed because the display was state and the `on_show` entity event has
  // no replay: a client that mounted after the show, or whose WS attach lost the
  // race, had to recover the pin from `context_data`. Three channels then needed a
  // freshness baseline to stop them re-firing each other and resurrecting a display
  // the user had navigated away from.
  //
  // Restore is now the loader's job (`routeProcessPointer`), answered against the
  // URL instead of a mount timestamp, so the live event is the only channel left and
  // needs no de-duplication: `openDock` already no-ops on a URL that is current or
  // pending, which is what makes `on_show`'s broadcast to every client idempotent.

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
            {session ? (
              <WorkspaceChildStrip
                processTab={session.processTab}
                processDock={session.processDock}
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
            {/* In vibe the content IS the workspace's display, so it wears the
                workspace chrome (history, promote, annotate). In standard mode it
                is just a document at its own address and gets none. */}
            {/* Unconditional: ContentPanel's ancestry must not change across a
                mode toggle, or the dirty editor beneath it remounts and loses its
                buffer. The chrome hides itself instead. */}
            <DisplayChrome process={persistedProcess ?? process} latestShown={latestShown} active={isVibe}>
              <ContentPanel minimalChrome={isVibe} contentEpoch={showNonce} />
            </DisplayChrome>
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
