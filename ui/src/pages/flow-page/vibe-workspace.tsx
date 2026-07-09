import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { WebappViewer } from '@src/components/webapp-viewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
import { HtmlPreview } from '@src/components/html-preview/HtmlPreview';
import { McpAppPreview } from '@src/components/mcp-app-preview/McpAppPreview';
import PersistentIframe, { PersistentIframeHandle } from '@src/components/persistent-iframe';
import { DisplayToolbar, WebappDisplayToolbar } from '@src/components/display-toolbar';
import { captureElementAsImageFile } from '@src/components/display-toolbar/capture-region';
import { annotateImage } from '@src/components/image-annotator/image-annotator-store';
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@src/components/ui/resizable';
import { useAgentContext } from '@src/contexts/agent-context';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { useViewerStore, useProcessWebApp } from '@src/hooks/flow-hooks';
import { isMcpAppPath } from '@src/lib/mcp-app-resources';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForPath, editorForType } from '@src/navigation/asset-doc-types';
import { useEntity } from '@src/hooks/entity-hooks';
import { DisplayHistoryButton } from './display-history-button';
import {
  AgenticProcess,
  dataContext,
  type DisplayEntry,
  FlowData,
  fsStore,
  ProcessKind,
  Project,
  TypeId,
  ViewType,
} from '@sdk';
import { resolveProcessInputDir } from '@src/utils/upload-to-input-dir';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { setActiveTabParent } from '@src/tabs/tab-parent-context';
import { setupTabAndAdopt } from '@src/tabs/setup-tab-and-adopt';
import { notify } from '@src/notifications/notify';
import { WorkspaceChildStrip } from './workspace-child-strip';
import { ContentPanel } from './content-panel/content-panel';
import { launchVibeSessionForProject } from './use-start-vibe-session';
import { VIBE_STARTER_PROMPTS } from './vibe-starter-prompts';
import type { VibeWorkspaceSession } from './use-vibe-workspace-session';
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
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { normalizeVibeModelTier, VIBE_MODEL_DEFAULT, VibeModelSelect } from './vibe-model-select';


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

/** Mount the right asset editor for a raw path — shared extension rule
 *  (`editorForPath`, same as the `navigate_vfs` ui_command handler). One vibe
 *  addition: a shown ``.html`` file is a DELIVERABLE (chart/diagram/one-file
 *  app), so it renders in the sandboxed HtmlPreview instead of the code
 *  editor's source view. */
function vfsEditorEl(absPath: string, refreshKey?: number, process?: AgenticProcess | null) {
  if (isMcpAppPath(absPath)) {
    return <McpAppPreview key={`${absPath}:${refreshKey ?? 0}`} path={absPath} process={process ?? null} refreshKey={refreshKey} />;
  }
  if (/\.html?$/i.test(absPath)) {
    return <HtmlPreview key={`${absPath}:${refreshKey ?? 0}`} path={absPath} />;
  }
  const pointer = AssetDocPointer.forVfs(editorForPath(absPath), absPath).toPointer();
  return <AssetEditorRouter key={`${pointer}:${refreshKey ?? 0}`} pointer={pointer} />;
}

/**
 * Read the most-recent agent `focus` off the AgenticProcess stream — the SAME
 * fields the URL-driven `useActiveViewer.focusFromStream` reads (`focus`,
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
  const { project, flow } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  // Select only the stable setter — subscribing to the whole store would
  // re-render this component on its own `currentContext` writes (it never reads it).
  const setCurrentContext = useViewerStore((s) => s.setCurrentContext);

  // Register this workspace's display tab as the parent for any tab materialized
  // while we're mounted (the open button, links inside child content). This is
  // the ONLY child-tab grouping seam — consumed at the tab chokepoint.
  useEffect(() => {
    setActiveTabParent(session.displayTab?.id ?? null);
    return () => setActiveTabParent(null);
  }, [session.displayTab?.id]);

  // The Display is a real Tab owned by this process — the anchor children are
  // parented to and the row the strip renders. The route loader mints it on
  // the display URL; this covers the paths it can't (deep-linked child URLs,
  // a row lost to the orphan reap after the process recovered). Idempotent
  // get-or-create; a failed mint (e.g. the process entity is gone) just leaves
  // displayTab null, same as before.
  useEffect(() => {
    if (session.displayTab) return;
    void setupTabAndAdopt(session.displayDock);
  }, [session.displayTab, session.displayDock]);

  // id-based TypeId (NOT project.typeId, which is the uname form `project-@local`) —
  // must match the target HomeLanding.handleVibeSubmit created the process with.
  const target = useMemo(
    () => (project?.id ? new TypeId(Project.type, project.id).toString() : null),
    [project?.id],
  );

  // The display's process. On the display URL `flow` IS the process; on a child
  // URL `flow` is the child's entity, so the agent-driven display machinery
  // (onShow/webapp/focus) goes inert — correct, since a child URL renders the
  // ContentPanel override instead of the pin.
  const activeProcess =
    flow instanceof AgenticProcess && flow.id === session.processId ? flow : null;
  const streamItems = useAgenticProcessStream(activeProcess);
  const focus = useVibeFocus(streamItems);

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
    // tab) still lands on the deliverable — the on_show entity event has no replay.
    const lastShown = (activeProcess.context_data as { last_shown?: DisplayShowTarget } | undefined)
      ?.last_shown;
    const stack = activeProcess.displayStack;
    setShown(lastShown ?? (stack.length ? stack[stack.length - 1] : null));
    return activeProcess.onShow((payload) => {
      setShown(payload);
      setShowNonce((n) => n + 1);
    });
  }, [activeProcess]);

  // The `flow show` history (oldest first) is the AUTHORITATIVE server stack —
  // derived from the reactive process entity (the wholesale-replace guard keeps
  // it fresh), never a hand-appended local mirror. `useEntity` re-renders on the
  // backend's context_data update.
  const reactiveProcess = useEntity<AgenticProcess>(activeProcess?.typeId ?? null);
  const displayStack = useMemo(
    () => reactiveProcess.data?.displayStack ?? activeProcess?.displayStack ?? [],
    [reactiveProcess.data, activeProcess],
  );

  // Open a past display as its OWN standard tab (the reusable behavior): convert
  // the stored target to its dock pointer and navigate. Webapps have no dock
  // editor — re-focus the live Display instead.
  const onOpenHistoryEntry = useCallback(
    (entry: DisplayEntry) => {
      const ptr = assetPointerForTarget(entry)?.toDockPointer() ?? null;
      navigation.openDock(ptr ?? session.displayDock);
    },
    [navigation, session.displayDock],
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
    t,
    navigation,
    activeProcess,
    handleAnnotateDisplay,
    submitStarterPrompt,
  ]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={36} minSize={24} maxSize={55}>
        <EntityExecutionPanel
          target={target}
          processType={ProcessKind.Chat}
          className="h-full border-r border-border"
          dense
          // "New" starts a fresh build session; the function form of
          // leadingSlot hides the panel's built-in new-session icon so the
          // header shows exactly one new-chat affordance.
          leadingSlot={({ startNewSession }) => (
            <button
              type="button"
              onClick={startNewSession}
              title={t`New build`}
              // Carries the panel's new-session testid: this pill replaces the
              // built-in icon button (hidden by the function-form leadingSlot),
              // and tests use it as the vibe-workspace mount signal.
              data-testid="entity-execution-new"
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              {t`New`}
            </button>
          )}
          emptyStateText={t`What do you want to work on`}
          newSessionLabel={t`New build`}
          historyLabel={t`Build history`}
          pastSessionsLabel={t`Past builds`}
          noPastSessionsLabel={t`No past builds`}
          defaultProjectId={project?.id ?? null}
          defaultWorkdir={project?.fs_storage_mount_path ?? null}
          defaultModel={VIBE_MODEL_DEFAULT}
          modelSelectSlot={({ value, disabled, onChange }) => (
            <VibeModelSelect
              value={normalizeVibeModelTier(value)}
              onChange={(next) => onChange(next)}
              disabled={disabled}
              triggerClassName="h-9 w-[112px]"
            />
          )}
          // Keep the chat bound to the workspace's process as the user browses
          // its child tabs (on a child URL `target`'s latest-wins pick could
          // otherwise drift to another session).
          initialProcessId={session.processId}
          onProcessCreated={(p) => p.enableAssistant()}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={64} minSize={45}>
        <div className="flex h-full flex-col">
          <WorkspaceChildStrip displayTab={session.displayTab} displayDock={session.displayDock} />
          <div className="min-h-0 flex-1">
            {/* On the display URL: the agent-driven pin. On a child URL: the
                child's ContentPanel (chrome-less). */}
            {session.onDisplayUrl ? (
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
