import { WebappViewer } from '@src/components/webapp-viewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
import PersistentIframe, { PersistentIframeHandle } from '@src/components/persistent-iframe';
import { DisplayToolbar, WebappDisplayToolbar } from '@src/components/display-toolbar';
import { captureElementAsImageFile } from '@src/components/display-toolbar/capture-region';
import { annotateImage } from '@src/components/image-annotator/image-annotator-store';
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@src/components/ui/resizable';
import { useAgentContext } from '@src/contexts/agent-context';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { useViewerStore, useProcessWebApp, useAppDisplay } from '@src/hooks/flow-hooks';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, editorForPath, editorForType } from '@src/navigation/asset-doc-types';
import { useEntity } from '@src/hooks/entity-hooks';
import { DisplayHistoryButton } from './display-history-button';
import {
  AgenticProcess,
  dataContext,
  type DisplayEntry,
  FlowData,
  fsStore,
  TypeId,
  ViewType,
} from '@sdk';
import { resolveProcessInputDir } from '@src/utils/upload-to-input-dir';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';
import { shellIdFromShowTarget } from '@src/navigation/shell-show-target';
import { ViewMode } from '@src/contexts/view-mode-context';
import { WorkspaceChildStrip } from './workspace-child-strip';
import { useProcessSurface } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { ContentPanel } from './content-panel/content-panel';
import { launchVibeSessionForProject } from './use-start-vibe-session';
import { VIBE_STARTER_PROMPTS } from './vibe-starter-prompts';
import {
  type VibeWorkspaceSession,
  useVibeWorkspaceSessionHost,
} from './use-vibe-workspace-session';
import { VibeChatPane } from './vibe-chat-pane';
import {
  buildDisplayAnnotationPrompt,
  displayAnnotationContextForDock,
  displayAnnotationContextForPath,
  displayAnnotationContextForShown,
  displayAnnotationContextForWebapp,
  displayAnnotationImageName,
  type DisplayAnnotationContext,
  type DisplayShowTarget,
} from './display-annotation';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

const McpAppPreview = lazy(() =>
  import('@src/components/mcp-app-preview/McpAppPreview').then((m) => ({ default: m.McpAppPreview })),
);

interface VibeFocus {
  viewType: ViewType | null;
  path?: string;
  port?: string;
}

/** The dock pointer a shown target opens as its own tab — the single type/path →
 *  editor rule shared by the current-display render and the history popover. */
function assetPointerForTarget(target: DisplayShowTarget): AssetDocPointer | null {
  if (target.kind === 'webapp') return null; // webapps have no dock editor
  const editor = target.type ? editorForType(target.type) : undefined;
  if (editor && target.typeid) return AssetDocPointer.forTypeId(editor, new TypeId(target.typeid));
  if (target.path) return AssetDocPointer.forVfs(editorForPath(target.path), target.path);
  return null;
}

/** Mount the right viewer/editor for a raw path — ONE shared extension rule
 *  (`editorForPath`): html→HtmlPreview, images/video/audio→MediaViewer,
 *  markdown/code→their editors, all via AssetEditorRouter. MCP apps stay a
 *  direct mount here only for the `refreshKey` PROP — a soft inner reload of
 *  the running app on turn-end instead of the full remount the keyed router
 *  path does (the router's own MCP_APP case threads the same process from
 *  agent context). */
function vfsEditorEl(absPath: string, refreshKey?: number, process?: AgenticProcess | null) {
  const editor = editorForPath(absPath);
  if (editor === AssetEditor.MCP_APP) {
    return (
      <Suspense fallback={null}>
        <McpAppPreview
          key={`${absPath}:${refreshKey ?? 0}`}
          path={absPath}
          process={process ?? null}
          refreshKey={refreshKey}
        />
      </Suspense>
    );
  }
  const pointer = AssetDocPointer.forVfs(editor, absPath).toPointer();
  return <AssetEditorRouter key={`${pointer}:${refreshKey ?? 0}`} pointer={pointer} />;
}

/**
 * Read the most-recent agent `focus` off the AgenticProcess stream (`focus`,
 * `data.path`, `data.metadata.port`). This is how the display knows which viewer
 * to show; it is NOT derived from the URL (the URL stays the standard process
 * dock URL — the viewer never touches it).
 */
function useVibeFocus(items: FlowData[]): VibeFocus {
  return useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.focus) {
        const d = it.data as { path?: string; metadata?: { port?: unknown } } | undefined;
        const port = d?.metadata?.port;
        const portText =
          typeof port === 'string' || typeof port === 'number' ? String(port) : undefined;
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
 * (left) next to a live "display" (right). It is a pure OVERLAY, no baggage:
 *
 * - The chat is the existing agentic-process chat UI (`EntityExecutionPanel`).
 * - The display reuses the existing viewer components (`WebappViewer` /
 *   `CodeEditor` / `DiffViewer`), selected by the agent's `focus` stream, with
 *   per-viewer context fed through `useViewerStore` — the same channel the
 *   normal `ContentPanel`/`WebappViewer` already read (no port sniffing, no
 *   override prop). The viewer selection never changes the URL.
 */
interface VibeWorkspaceProps {
  /** The resolved workspace session (display URL vs a child URL of it). */
  session: VibeWorkspaceSession;
}

export function VibeWorkspace({ session }: VibeWorkspaceProps) {
  const { t } = useLingui();
  const { project } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  // Select only the stable setter — subscribing to the whole store would
  // re-render this component on its own `currentContext` writes (it never reads it).
  const setCurrentContext = useViewerStore((s) => s.setCurrentContext);

  // Bind by the workspace session id. The same hook also owns parent
  // registration/materialization for process and child presentations.
  const activeProcess = useVibeWorkspaceSessionHost(session);
  // Vibe has no InteractiveTerminal, so this is where the session's transport
  // is kept aligned with the view mode while the workspace is on screen.
  useProcessSurface({ process: activeProcess });

  const streamItems = useAgenticProcessStream(activeProcess);
  const focus = useVibeFocus(streamItems);
  const reactiveProcess = useEntity<AgenticProcess>(activeProcess?.typeId ?? null);
  const persistedProcess = reactiveProcess.data ?? activeProcess;
  const displayStack = persistedProcess?.displayStack ?? [];
  const lastShown = (
    persistedProcess?.context_data as { last_shown?: DisplayShowTarget } | undefined
  )?.last_shown;
  const persistedShown =
    lastShown ?? (displayStack.length ? displayStack[displayStack.length - 1] : null);
  const persistedShownKey = persistedShown ? JSON.stringify(persistedShown) : '';

  // Agent-declared display focus (`flow show` → on_show entity event). The
  // last shown target PINS the display: it outranks the involuntary per-file
  // write focus noise from the stream. A new show replaces the pin; switching
  // to another process clears it.
  const [shown, setShown] = useState<DisplayShowTarget | null>(null);
  // Bumped on every `flow show` — even for the SAME webapp port. The iframe
  // registry keys by src (get-host?port=N), so a same-port re-show reuses the
  // cached iframe and shows stale content after a rebuild; feeding this as the
  // frame's cacheKey forces a reload on each show.
  const [showNonce, setShowNonce] = useState(0);
  useEffect(() => {
    if (!activeProcess) {
      setShown(null);
      return;
    }
    // Restore the persisted pin (context_data.last_shown / newest stack entry) so
    // a display mounted AFTER the agent's `flow show` (page reload, late-opened
    // tab) still lands on the deliverable — the on_show entity event has no
    // replay. Key the effect on the payload, not entity identity: the SDK
    // updates cached entities in place.
    //
    // A shell target is NOT restorable content: the terminal it addresses lives
    // on as its own child tab, and re-pinning it here would drag the user back
    // into the terminal on every reload.
    setShown(shellIdFromShowTarget(persistedShown) ? null : persistedShown);
  }, [activeProcess, persistedShownKey]);

  useEffect(() => {
    if (!activeProcess) return;
    return activeProcess.onShow((payload) => {
      // A terminal is hosted as a tab, not rendered in the pane — open its dock
      // and let workspace adoption place it (the journey's path exactly).
      const shellId = shellIdFromShowTarget(payload);
      if (shellId) {
        void navigation.openShell(shellId, { viewMode: ViewMode.Vibe });
        return;
      }
      setShown(payload);
      setShowNonce((n) => n + 1);
    });
  }, [activeProcess, navigation]);

  // The `flow show` history (oldest first) is the AUTHORITATIVE server stack —
  // read on every render from the reactive process entity, never a
  // hand-appended local mirror. `useEntity` re-renders on the backend's
  // context_data update even when the SDK mutates the entity in place.

  // Open a past display as its OWN standard tab (the reusable behavior): convert
  // the stored target to its dock pointer and navigate. Webapps have no dock
  // editor — re-focus the live Display instead.
  const onOpenHistoryEntry = useCallback(
    (entry: DisplayEntry) => {
      const ptr = assetPointerForTarget(entry)?.toDockPointer() ?? null;
      navigation.openDock(ptr ?? session.processDock);
    },
    [navigation, session.processDock],
  );

  // Feed the dev-server port into the viewer store — the exact channel
  // WebappViewer reads (`currentContext.viewerOptions.port`). A shown webapp
  // wins over stream focus. This is store state, not URL state.
  //
  // A shown APP is deliberately absent here: it carries its own identity
  // (artifact_id) and derives its runtime, so pushing its port into the shared
  // viewer store would re-create the port side-channel this replaces — and
  // leave a stale port behind the moment the app is served instead.
  useEffect(() => {
    if (shown?.kind === 'app') return;
    if (shown?.kind === 'webapp' && shown.port != null) {
      setCurrentContext({ viewerOptions: { port: String(shown.port) } });
      return;
    }
    if (!focus.viewType) return;
    setCurrentContext({ viewerOptions: focus.port ? { port: focus.port } : {} });
  }, [shown, focus.viewType, focus.port, setCurrentContext]);

  const onRetry = useCallback((msg: string) => void dataContext.agenticProcess?.prompt(msg), []);

  // Webapp host — resolved from the shown port (no artifact needed) so the
  // display can mount a BARE iframe under the two-tier toolbar instead of the
  // artifact-driven WebappViewer. Hooks run unconditionally; null port → ''.
  const webappPort = useMemo(
    () => (shown?.kind === 'webapp' && shown.port != null ? String(shown.port) : null),
    [shown],
  );
  const webAppConfig = useProcessWebApp(activeProcess, webappPort);
  const webappFrameRef = useRef<PersistentIframeHandle>(null);

  // A shown app: identity is the artifact, runtime (dev server vs built output
  // we serve) is derived and user-switchable.
  const appDisplay = useAppDisplay(
    activeProcess,
    shown?.kind === 'app' ? (shown.artifact_id ?? null) : null,
    shown?.kind === 'app' && shown.port != null ? String(shown.port) : null,
    shown?.kind === 'app' && (shown.runtime === 'dev' || shown.runtime === 'served') ? shown.runtime : null,
  );
  const appFrameRef = useRef<PersistentIframeHandle>(null);

  const submitAnnotatedDisplay = useCallback(async (file: File, context: DisplayAnnotationContext) => {
    if (!activeProcess?.id) throw new Error('No active Vibe session');

    const dir = await resolveProcessInputDir(activeProcess.id);
    if (!dir) throw new Error('Could not resolve the chat input directory');

    const uploads = await fsStore.getState().uploadFiles(new TypeId(dir.compute_node_id), dir.abs_path, [file]);
    await Promise.all(uploads.map((upload) => upload.waitForCompletion()));

    const filePath = `${dir.abs_path}/${file.name}`;
    await activeProcess.prompt(buildDisplayAnnotationPrompt({ fileName: file.name, filePath, context }));
  }, [activeProcess]);

  const handleAnnotateDisplay = useCallback(async (
    target: HTMLElement,
    context = displayAnnotationContextForDock(currentDock),
  ) => {
    try {
      const file = await captureElementAsImageFile(target, displayAnnotationImageName(context));
      const submitted = await annotateImage(file, {
        submitLabel: t`Submit`,
        onSubmit: (annotated) => submitAnnotatedDisplay(annotated, context),
      });
      if (submitted) notify.success({ title: t`Annotation submitted` });
    } catch (err) {
      notify.error({
        title: t`Could not annotate view`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [currentDock, submitAnnotatedDisplay, t]);

  const submitStarterPrompt = useCallback(
    async (prompt: string) => {
      const existing =
        activeProcess ?? (await AgenticProcess.getById<AgenticProcess>(session.processId).catch(() => null));
      if (existing) {
        await existing.prompt(prompt);
        return;
      }
      if (!project?.id) return;
      await launchVibeSessionForProject({
        projectId: project.id,
        workdir: project.fs_storage_mount_path || project.name || undefined,
        message: prompt,
        navigation,
      });
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
    // The display-history popover control, rendered next to each toolbar's
    // open-in-window icon.
    const historySlot = <DisplayHistoryButton stack={displayStack} onOpen={onOpenHistoryEntry} />;

    // Fallback (nothing explicitly shown): the artifact-driven WebappViewer,
    // which carries its own chrome — left unwrapped.
    const preview = (
      <WebappViewer
        onWebappErrorRetry={onRetry}
        onAnnotate={(target) => {
          void handleAnnotateDisplay(
            target,
            displayAnnotationContextForWebapp(webAppConfig.host, webappPort ?? focus.port),
          );
        }}
      />
    );

    // True empty state — nothing shown yet AND no stream focus: offer starter
    // prompt chips. Clicking one submits it to the chat (prompt + enter); the
    // agent then drives the first `flow show`. (`!shown` already implies an empty
    // stack — the pin restores from the newest entry.)
    if (!shown && !focus.viewType) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
          data-testid="display-empty-state"
        >
          <p className="text-sm text-muted-foreground">
            <Trans>Nothing to display yet — try one to get started</Trans>
          </p>
          <div className="flex max-w-md flex-wrap justify-center gap-2">
            {VIBE_STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => void submitStarterPrompt(p)}
                data-testid="display-starter-chip"
                className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      );
    }

    // A shown viewer under the two-tier toolbar: per-type toolbar (left) +
    // the generic action (right). For entities/files that action is "open in
    // a new tab" — IN-APP dock navigation (promotes the item to a full
    // Flowpad content tab), NOT a browser tab; only webapps open externally.
    const openPtrInTab = (ptr: AssetDocPointer) => () => navigation.openDock(ptr.toDockPointer());
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
        case 'app': {
          if (!appDisplay.src) return preview;
          const appContext = displayAnnotationContextForShown(shown, appDisplay.src, appDisplay.port);
          return (
            <DisplayToolbar
              externalUrl={appDisplay.src}
              onAnnotate={(target) => {
                void handleAnnotateDisplay(target, appContext);
              }}
              historySlot={historySlot}
              perType={
                <WebappDisplayToolbar
                  host={appDisplay.src}
                  port={appDisplay.port ?? ''}
                  runtime={appDisplay.runtime}
                  runtimes={appDisplay.available}
                  onRuntimeChange={appDisplay.setRuntime}
                  onRefresh={() => appFrameRef.current?.refresh()}
                />
              }
            >
              <PersistentIframe
                // Keyed by src so a runtime switch remounts the wrapper.
                // Changing src in place leaves BOTH the outgoing and incoming
                // frames parked at opacity-0 — the registry activates a
                // container on mount, and an in-place src change retires the
                // old one without ever activating the new one. Switching
                // runtimes is the first thing to change src routinely; the
                // port-only path below effectively never does.
                key={appDisplay.src}
                ref={appFrameRef}
                testId="vibe-app-frame"
                src={appDisplay.src}
                cacheKey={showNonce + refreshStamp}
                onErrorRetry={() => onRetry(t`The web app is not working, please try to fix it.`)}
              />
            </DisplayToolbar>
          );
        }
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
              <PersistentIframe
                ref={webappFrameRef}
                testId="vibe-webapp-frame"
                src={webAppConfig.host}
                // Reload on each re-show (same-port stale guard) AND on the
                // agent's turn-end (rebuild picked up) — the registry keys the
                // iframe by src, so a changing cacheKey is what forces a reload.
                cacheKey={showNonce + refreshStamp}
                onErrorRetry={() => onRetry(t`The web app is not working, please try to fix it.`)}
              />
            </DisplayToolbar>
          );
        }
        case 'entity': {
          const entityContext = displayAnnotationContextForShown(shown);
          const editor = shown.type ? editorForType(shown.type) : undefined;
          if (editor && shown.typeid) {
            const ptr = AssetDocPointer.forTypeId(editor, new TypeId(shown.typeid));
            return (
              <DisplayToolbar
                onOpenInTab={openPtrInTab(ptr)}
                onAnnotate={(target) => {
                  void handleAnnotateDisplay(target, entityContext);
                }}
                historySlot={historySlot}
              >
                <AssetEditorRouter key={`${ptr.toPointer()}:${refreshStamp}`} pointer={ptr.toPointer()} />
              </DisplayToolbar>
            );
          }
          // Type without a bespoke editor — fall back to the raw file view.
          if (shown.path) return wrapAsset(shown.path, vfsEditorEl(shown.path, refreshStamp, activeProcess));
          break;
        }
        case 'vfs':
          if (shown.path) return wrapAsset(shown.path, vfsEditorEl(shown.path, refreshStamp, activeProcess));
          break;
      }
    }

    switch (focus.viewType) {
      case ViewType.EDITOR:
        return focus.path
          ? wrapAsset(focus.path, <CodeEditor activePath={focus.path} readOnly />)
          : preview;
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
    displayStack,
    onOpenHistoryEntry,
    showNonce,
    refreshStamp,
    focus.viewType,
    focus.path,
    focus.port,
    onRetry,
    webAppConfig,
    webappPort,
    appDisplay,
    t,
    navigation,
    activeProcess,
    handleAnnotateDisplay,
    submitStarterPrompt,
  ]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={36} minSize={24} maxSize={55}>
        {activeProcess && <VibeChatPane process={activeProcess} />}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={64} minSize={45}>
        <div className="flex h-full flex-col">
          <WorkspaceChildStrip
            processTab={session.processTab}
            processDock={session.processDock}
            projectId={project?.id ?? null}
          />
          <div className="min-h-0 flex-1">
            {/* On the display URL: the agent-driven pin. On a child URL: the
                child's ContentPanel (chrome-less). */}
            {session.onProcessUrl ? (
              displayEl
            ) : (
              <DisplayToolbar
                onAnnotate={(target) => {
                  void handleAnnotateDisplay(target, displayAnnotationContextForDock(currentDock));
                }}
              >
                <ContentPanel minimalChrome />
              </DisplayToolbar>
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default VibeWorkspace;
