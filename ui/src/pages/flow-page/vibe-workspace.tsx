import type { ShowTarget } from '@sdk';
import { WebappViewer } from '@src/components/webapp-viewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { WebappDisplay } from '@src/components/webapp-display/WebappDisplay';
import { DisplayToolbar, WebappDisplayToolbar } from '@src/components/display-toolbar';
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@src/components/ui/resizable';
import { useAgentContext } from '@src/contexts/agent-context';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { useViewerStore, useProcessWebApp } from '@src/hooks/flow-hooks';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForPath } from '@src/navigation/asset-doc-types';
import { DisplayHistoryButton } from './display-history-button';
import { AgenticProcess, type DisplayEntry, FlowData, ViewType } from '@sdk';
import {dockForDisplayTarget} from '@src/navigation/display-target-pointer';

import { isPortDisplayTarget, openActiveDisplay } from '@src/navigation/open-active-display';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';
import { tagAttrs } from '@src/tags/tag-attrs';
import { WorkspaceChildStrip } from './workspace-child-strip';
import { useProcessSurface } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { ContentPanel } from './content-panel/content-panel';
import { DisplayChrome } from './display-chrome';
import { launchVibeSessionForProject } from './use-start-vibe-session';
import { VIBE_STARTER_PROMPTS } from './vibe-starter-prompts';
import { type VibeWorkspaceSession, useVibeWorkspaceSessionHost } from './use-vibe-workspace-session';
import { VibeChatPane } from './vibe-chat-pane';
import {displayAnnotationContextForDock, displayAnnotationContextForPath, displayAnnotationContextForShown, displayAnnotationContextForWebapp, type DisplayAnnotationContext} from './display-annotation';

import { submitDisplayAnnotation } from './display-annotation-submit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface VibeFocus {
  viewType: ViewType | null;
  path?: string;
  port?: string;
}

/**
 * Read the most-recent agent `focus` off the AgenticProcess stream (`focus`,
 * `data.path`, `data.metadata.port`) — the involuntary per-write focus the display
 * FALLS BACK to when nothing is addressed. Deliberately not URL state: it changes
 * many times per turn, so routing it would spam navigation.
 */
function useVibeFocus(items: FlowData[]): VibeFocus {
  return useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.focus) {
        const d = it.data as { path?: string; metadata?: { port?: unknown } } | undefined;
        const port = d?.metadata?.port;
        const portText = typeof port === 'string' || typeof port === 'number' ? String(port) : undefined;
        return {
          viewType: it.focus,
          path: d?.path ?? it.attributes?.path,
          port: portText && portText !== '' ? portText : undefined,
        };
      }
    }
    return { viewType: null };
  }, [items]);
}

/**
 * VibeWorkspace — the Lovable-style creator surface: a persistent side chat
 * (left) next to a live "display" (right).
 *
 * The display is an ADDRESS: a `flow show` navigates, and on the resulting child
 * URL the display body is `ContentPanel` under `DisplayChrome`. What is left in
 * this file is the pane for what has no address — a BARE port (a dev server with
 * no artifact behind it), the involuntary `focus` stream fallback, and the empty
 * state — plus the chat and the child strip that host them.
 */
interface VibeWorkspaceProps {
  /** The resolved workspace session (display URL vs a child URL of it). */
  session: VibeWorkspaceSession;
}

export function VibeWorkspace({ session }: VibeWorkspaceProps) {
  const { t } = useLingui();
  const { project } = useAgentContext();
  // Hoisted: a string dep is identity-stable, so the memo/callbacks below don't
  // re-run on every refresh that mints a new project object.
  const projectId = project?.id ?? null;
  const { navigation, currentDock } = useDockNavigation();
  // Select only the stable setter — subscribing to the whole store would
  // re-render this component on its own `currentContext` writes (it never reads it).
  const setCurrentContext = useViewerStore((s) => s.setCurrentContext);

  // Bind by the workspace session id. The same hook also owns parent
  // registration/materialization for process and child presentations.
  const activeProcess = useVibeWorkspaceSessionHost(session);
  // Vibe has no InteractiveTerminal, so this is where the session's transport is
  // kept aligned with the view mode while the workspace is on screen. It also
  // hands back the reactive entity, so this component needs no subscription of
  // its own.
  const persistedProcess = useProcessSurface({ process: activeProcess });

  const streamItems = useAgenticProcessStream(activeProcess);
  const focus = useVibeFocus(streamItems);
  // Memoized for the same reason the chrome does it: a fresh `[]` fallback each
  // render would invalidate every memo that reads the stack.
  const displayStack = useMemo(() => persistedProcess?.displayStack ?? [], [persistedProcess]);
  const lastShown = (persistedProcess?.context_data as { last_shown?: ShowTarget } | undefined)?.last_shown;
  const persistedShown = lastShown ?? (displayStack.length ? displayStack[displayStack.length - 1] : null);
  const persistedShownKey = persistedShown ? JSON.stringify(persistedShown) : '';

  // The agent's display focus is now the URL: a `flow show` NAVIGATES, the route
  // renders the target, and this component sees it as a child URL. The one
  // exception is a PORT target (`webapp` / `app`), which has no dock address yet —
  // its identity is an artifact whose runtime is derived, and ContentPanel's
  // WEB_APP case is a bare viewer with no runtime switcher and no cache-key path,
  // so collapsing it early would visibly regress the running-app display. Those
  // stay pinned here until the app grammar lands, and this state holds ONLY them.
  const [shown, setShown] = useState<ShowTarget | null>(null);
  // Bumped on every `flow show` — even for the SAME webapp port. The iframe
  // registry keys by src (get-host?port=N), so a same-port re-show reuses the
  // cached iframe and shows stale content after a rebuild; feeding this as the
  // frame's cacheKey forces a reload on each show.
  const [showNonce, setShowNonce] = useState(0);
  // The payload of the newest show — see `DisplayChrome.latestShown`.
  const [latestShown, setLatestShown] = useState<ShowTarget | null>(null);
  useEffect(() => {
    if (!activeProcess) {
      setShown(null);
      return;
    }
    // Restore ONLY a port pin. Everything else restores as a URL, in the loader
    // (`routeProcessPointer`), which is what removed the freshness baseline this
    // effect used to need: a durable `last_shown` re-fires forever unless something
    // records that the user dealt with it, and the URL is that record.
    //
    // A shell target is not restorable content either — the terminal it addresses
    // lives on as its own child tab, and re-pinning it would drag the user back into
    // the terminal on every reload.
    setShown(isPortDisplayTarget(persistedShown) ? persistedShown : null);
    // Keyed on the payload, not on entity identity: the SDK mutates cached entities
    // in place, so the object reference is not a change signal. `persistedShown` is
    // read through that key deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProcess, persistedShownKey]);

  // The FIRST show after a mount pushes; every one after it replaces — otherwise the
  // first show overwrites the URL the user arrived on and Back ejects them from the
  // workspace instead of returning them to it.
  const hasPushedDisplayRef = useRef(false);

  useEffect(() => {
    if (!activeProcess) return;
    return activeProcess.onShow((payload) => {
      // The nonce is bumped BEFORE the navigation decision, unconditionally: a
      // re-show of the SAME target is a no-op navigation (same URL), and that is
      // precisely the case it exists for — the iframe registry keys by `src`, so
      // without it a rebuild behind an unchanged address renders stale content.
      setShowNonce((n) => n + 1);
      setLatestShown(payload);
      const committed = openActiveDisplay({
        target: payload,
        navigation,
        host: session.processDock.pointer ?? null,
        projectId,
        currentDock,
        push: !hasPushedDisplayRef.current,
      });
      if (committed) {
        hasPushedDisplayRef.current = true;
        return;
      }
      // Not addressable (a port target, or a type with no editor and no path):
      // the pane keeps it.
      setShown(payload);
    });
  }, [activeProcess, navigation, session.processDock.pointer, projectId, currentDock]);

  // Open a past display as its OWN standard tab (the reusable behavior): convert
  // the stored target to its dock pointer and navigate.
  //
  // Port targets are the deliberate exception. `dockForDisplayTarget` maps them
  // to a WEB_APP dock — right for a tab-based mode, wrong here, because in vibe
  // the Display pane IS where a running app renders. Sending the user to a
  // separate tab would walk them out of the workspace to see something the pane
  // beside them can show, so a port entry re-PINS the Display instead — the same
  // write a live `flow show` does (the stack entry IS that show's payload), with
  // the nonce bump so a same-port re-show reloads the frame. Merely re-opening
  // the process dock is a no-op (the popover only exists on that dock), which
  // is why the pane used to stay on whatever it last showed.
  const onOpenHistoryEntry = useCallback(
    (entry: DisplayEntry) => {
      if (isPortDisplayTarget(entry)) {
        setShown(entry);
        setShowNonce((n) => n + 1);
        return;
      }
      // Same promotion as the toolbar's "open in a new tab": this opens a past
      // display as its OWN tab, so the assets-shaped dock must be rebased or the
      // chip collapses onto the scope-keyed Assets tab.
      const ptr = dockForDisplayTarget(entry);
      const own = ptr ? DockPointer.rebaseAssetsOntoProject(ptr, projectId) : null;
      navigation.openDock(own ?? session.processDock);
    },
    [navigation, session.processDock, projectId],
  );

  // The display-history popover, hoisted out of `displayEl` so BOTH display
  // branches carry it: the pane (a port target, the focus fallback, the empty
  // state) and the URL-addressed child. The stack is the same server-side history
  // either way — it belongs to the workspace, not to whichever viewer is up.
  const historySlot = useMemo(
    () => <DisplayHistoryButton stack={displayStack} onOpen={onOpenHistoryEntry} />,
    [displayStack, onOpenHistoryEntry],
  );


  // Feed the dev-server port into the viewer store — the exact channel
  // WebappViewer reads (`currentContext.viewerOptions.port`). A shown webapp
  // wins over stream focus. This is store state, not URL state.
  useEffect(() => {
    if (shown?.kind === 'webapp' && shown.port != null) {
      setCurrentContext({ viewerOptions: { port: String(shown.port) } });
      return;
    }
    if (!focus.viewType) return;
    setCurrentContext({ viewerOptions: focus.port ? { port: focus.port } : {} });
  }, [shown, focus.viewType, focus.port, setCurrentContext]);

  // Webapp host — resolved from the shown port (no artifact needed) so the
  // display can mount a BARE iframe under the two-tier toolbar instead of the
  // artifact-driven WebappViewer. Hooks run unconditionally; null port → ''.
  const webappPort = useMemo(
    () => (shown?.kind === 'webapp' && shown.port != null ? String(shown.port) : null),
    [shown],
  );
  const webAppConfig = useProcessWebApp(activeProcess, webappPort);
  const webappFrameRef = useRef<PersistentIframeHandle>(null);


  // The pane's own viewers (a bare port, the focus fallback) keep an annotate
  // action; the pipeline itself lives in `display-annotation.ts` — capturing,
  // annotating, uploading and prompting is not rendering.
  const handleAnnotateDisplay = useCallback(
    async (target: HTMLElement, context = displayAnnotationContextForDock(currentDock)) => {
      try {
        if (!activeProcess) throw new Error('No active Vibe session');
        const submitted = await submitDisplayAnnotation(activeProcess, target, context);
        if (submitted) notify.success({ title: t`Annotation submitted` });
      } catch (err) {
        notify.error({
          title: t`Could not annotate view`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeProcess, currentDock, t],
  );

  // FLOWPAD-2045: this is the ONLY affordance in an empty display, and its click
  // handler can do nothing with a rejected promise — so EVERY failure below used
  // to render identically to success: nothing happens. A refused prompt (the
  // bound process is mid-turn), a dead session id, a missing project — all
  // silent. Nothing here may fail quietly; report the reason and move on.
  const submitStarterPrompt = useCallback(
    async (prompt: string) => {
      try {
        const existing =
          activeProcess ?? (await AgenticProcess.getById<AgenticProcess>(session.processId).catch(() => null));
        if (existing) {
          // Mid-turn clicks ENQUEUE instead of racing a second turn onto a busy
          // process — `promptOrEnqueue` is the shared fork (also used by
          // ChatComposerBar.handleSend).
          await existing.promptOrEnqueue(prompt);
          return;
        }
        if (!project?.id) {
          throw new Error(
            `no vibe session resolved for ${session.processId} and no active project to start one in`,
          );
        }
        await launchVibeSessionForProject({
          projectId: project.id,
          workdir: project.fs_storage_mount_path || project.name || undefined,
          message: prompt,
          navigation,
        });
      } catch (error) {
        console.error('[Vibe] starter prompt failed', { prompt, processId: session.processId, error });
      }
    },
    [activeProcess, navigation, project?.fs_storage_mount_path, project?.id, project?.name, session.processId],
  );

  // Display precedence: explicit `flow show` target first (agent-intentional),
  // then stream focus (write/diff noise), then the webapp preview. Each viewer
  // self-resolves its data (WebappViewer from the store, AssetEditorRouter
  // from the pointer, CodeEditor from the path).
  // Live refresh: remount the shown editor when the agent's turn ends — every
  // edit happens inside a turn, and the CLI-worker chat stream carries no
  // per-file write items, so the turn edge is the refresh signal. Chat turns
  // end at `pending_user` (not COMPLETE — that's the one-shot execute path),
  // so listen on the workerStatus EDGE into any idle state rather than the
  // 'complete' event. Tradeoff (accepted): a remount drops unsaved in-editor
  // user edits; the editors autosave within ~2s, so the window is small.
  // Owned HERE, not in the chat pane that sets it: `New` rebinds the URL as soon
  // as the process lands, and this workspace stops rendering the pane while the
  // new entity resolves — pane-local state would die mid-flight and leave the
  // display's chips greyed out forever.
  const [newSessionPending, setNewSessionPending] = useState(false);

  const [refreshStamp, setRefreshStamp] = useState(0);
  useEffect(() => {
    setRefreshStamp(0);
    if (!activeProcess) return;
    return activeProcess.on('state_change', (change: { field?: string; newValue?: string }) => {
      if (change?.field !== 'workerStatus') return;
      if (change.newValue === 'pending_user' || change.newValue === 'complete') {
        setRefreshStamp((s) => s + 1);
      }
    });
  }, [activeProcess]);

  const displayEl = useMemo(() => {
    // Fallback (nothing explicitly shown): the artifact-driven WebappViewer,
    // which carries its own chrome — left unwrapped.
    const preview = (
      <WebappViewer
        onAnnotate={(target) => {
          void handleAnnotateDisplay(
            target,
            displayAnnotationContextForWebapp(webAppConfig.host, webappPort ?? focus.port),
          );
        }}
      />
    );

    // Nothing shown here AND no stream focus. `!shown` no longer implies an empty
    // history: an addressable target now lives in the URL, so the pane legitimately
    // sits empty while the workspace has a rich show history behind it (the user
    // clicked the Display home chip, or a redirect has not run). The history popover
    // is workspace chrome, not viewer chrome, so it must survive that — otherwise
    // stepping back to the Display home silently loses the way back into the stack.
    if (!shown && !focus.viewType) {
      const starter = (
        <div
          className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
          data-testid="display-empty-state"
        >
          <p className="text-sm text-muted-foreground">
            <Trans>Nothing to display yet — try one to get started</Trans>
          </p>
          <div className="flex max-w-md flex-wrap justify-center gap-2">
            {VIBE_STARTER_PROMPTS.map((descriptor) => {
              // One resolution per chip: label, key and submitted prompt alike.
              const p = t(descriptor);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => void submitStarterPrompt(p)}
                  // Held shut while `New` is creating the next session: until
                  // that lands, this display is still bound to the PREVIOUS
                  // process and a click here would prompt it instead
                  // (FLOWPAD-2045).
                  disabled={newSessionPending}
                  data-testid="display-starter-chip"
                  className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:pointer-events-none"
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
      );
      // Genuinely nothing yet → bare chips. Otherwise keep the toolbar so the
      // history stays one click away.
      return displayStack.length ? <DisplayToolbar historySlot={historySlot}>{starter}</DisplayToolbar> : starter;
    }

    // A pane viewer under the two-tier toolbar: per-type toolbar (left) + the
    // generic action (right). Promote-to-tab rebases onto the project shell first:
    // a bare ASSETS dock is scope-keyed (one tab per scope, sub-pointer folded
    // away) — right for browsing inside the Assets tab, wrong for a document that
    // must keep its own pointer and name. Same reason as `onOpenHistoryEntry`.
    const openPtrInTab = (ptr: AssetDocPointer) => () =>
      navigation.openDock(DockPointer.rebaseAssetsOntoProject(ptr.toDockPointer(), projectId));
    const wrapAsset = (path: string, node: React.ReactNode) => (
      <DisplayToolbar
        onOpenInTab={openPtrInTab(AssetDocPointer.forVfs(editorForPath(path), path))}
        onAnnotate={(target) => {
          void handleAnnotateDisplay(target, displayAnnotationContextForPath(path));
        }}
        historySlot={historySlot}
      >
        {node}
      </DisplayToolbar>
    );

    if (shown) {
      switch (shown.kind) {
        case 'webapp': {
          if (!webAppConfig.host) return preview;
          const webappContext = displayAnnotationContextForShown(shown, webAppConfig.host, webappPort);
          return (
            <DisplayToolbar
              externalUrl={webAppConfig.host}
              onAnnotate={(target) => {
                void handleAnnotateDisplay(target, webappContext);
              }}
              historySlot={historySlot}
              perType={
                <WebappDisplayToolbar
                  host={webAppConfig.host}
                  port={webappPort ?? ''}
                  onRefresh={() => webappFrameRef.current?.refresh()}
                />
              }
            >
              <WebappDisplay
                ref={webappFrameRef}
                processId={activeProcess?.id}
                testId="vibe-webapp-frame"
                src={webAppConfig.host}
                port={webappPort}
                // Reload on each re-show (same-port stale guard) AND on the
                // agent's turn-end (rebuild picked up) — the registry keys the
                // iframe by src, so a changing cacheKey is what forces a reload.
                cacheKey={showNonce + refreshStamp}
              />
            </DisplayToolbar>
          );
        }
      }
    }

    switch (focus.viewType) {
      case ViewType.EDITOR:
        return focus.path ? wrapAsset(focus.path, <CodeEditor activePath={focus.path} readOnly />) : preview;
      case ViewType.DIFF: {
        const diffContext: DisplayAnnotationContext = {
          kind: 'diff',
          title: 'Diff',
          path: focus.path,
          viewType: ViewType.DIFF,
        };
        return focus.path ? (
          <DisplayToolbar
            historySlot={historySlot}
            onAnnotate={(target) => {
              void handleAnnotateDisplay(target, diffContext);
            }}
          >
            <DiffViewer checkpoint_hash={focus.path} />
          </DisplayToolbar>
        ) : (
          preview
        );
      }
      case ViewType.WEB_APP:
      default:
        return preview;
    }
  }, [
    shown,
    historySlot,
    displayStack,
    showNonce,
    refreshStamp,
    focus.viewType,
    focus.path,
    focus.port,
    webAppConfig,
    webappPort,
    t,
    navigation,
    activeProcess,
    handleAnnotateDisplay,
    submitStarterPrompt,
    newSessionPending,
    projectId,
  ]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={36} minSize={24} maxSize={55}>
        {activeProcess && (
          <VibeChatPane
            process={activeProcess}
            newSessionPending={newSessionPending}
            onNewSessionPendingChange={setNewSessionPending}
          />
        )}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={64} minSize={45}>
        {/* Tagged so a journey can point at the half of the workspace that
            disappears the moment Vibe is left — the display and its tab strip. */}
        <div className="flex h-full flex-col" {...tagAttrs('VibeDisplay', 'label')}>
          <WorkspaceChildStrip
            processTab={session.processTab}
            processDock={session.processDock}
            projectId={projectId}
          />
          <div className="min-h-0 flex-1">
            {/* On the display URL: the agent-driven pin. On a child URL: the
                child's ContentPanel (chrome-less). */}
            {session.onProcessUrl ? (
              displayEl
            ) : (
              <DisplayChrome process={persistedProcess ?? activeProcess} latestShown={latestShown}>
                <ContentPanel minimalChrome contentEpoch={showNonce} />
              </DisplayChrome>
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default VibeWorkspace;
