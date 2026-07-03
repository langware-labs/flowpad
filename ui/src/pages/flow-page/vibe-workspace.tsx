import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { WebappViewer } from '@src/components/webapp-viewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
import PersistentIframe, { PersistentIframeHandle } from '@src/components/persistent-iframe';
import { DisplayToolbar, WebappDisplayToolbar } from '@src/components/display-toolbar';
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@src/components/ui/resizable';
import { useAgentContext } from '@src/contexts/agent-context';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { useViewerStore, useProcessWebApp } from '@src/hooks/flow-hooks';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForPath, editorForType } from '@src/navigation/asset-doc-types';
import { AgenticProcess, dataContext, FlowData, ProcessKind, Project, TypeId, ViewType, type ShowTarget } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';

/** Standalone URL for an asset/file pointer — opens the thing in its own dock
 *  in a new browser tab (the generic "open externally" for non-webapp items). */
function assetExternalUrl(ptr: AssetDocPointer): string {
  return window.location.origin + ptr.toDockPointer().toUrl();
}

interface VibeFocus {
  viewType: ViewType | null;
  path?: string;
  port?: string;
}

/** Mount the right asset editor for a raw path — shared extension rule
 *  (`editorForPath`, same as the `navigate_vfs` ui_command handler). */
function vfsEditorEl(absPath: string, refreshKey?: number) {
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
        return {
          viewType: it.focus as ViewType,
          path: d?.path ?? it.attributes?.path,
          port: port != null && port !== '' ? String(port) : undefined,
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
export function VibeWorkspace() {
  const { t } = useLingui();
  const { project, flow } = useAgentContext();
  const { navigation } = useDockNavigation();
  // Select only the stable setter — subscribing to the whole store would
  // re-render this component on its own `currentContext` writes (it never reads it).
  const setCurrentContext = useViewerStore((s) => s.setCurrentContext);

  // id-based TypeId (NOT project.typeId, which is the uname form `project-@local`) —
  // must match the target HomeLanding.handleVibeSubmit created the process with.
  const target = useMemo(
    () => (project?.id ? new TypeId(Project.type, project.id).toString() : null),
    [project?.id],
  );

  const activeProcess = flow instanceof AgenticProcess ? flow : null;
  const streamItems = useAgenticProcessStream(activeProcess);
  const focus = useVibeFocus(streamItems);

  // Agent-declared display focus (`flow show` → on_show entity event). The
  // last shown target PINS the display: it outranks the involuntary per-file
  // write focus noise from the stream. A new show replaces the pin; switching
  // to another process clears it.
  const [shown, setShown] = useState<ShowTarget | null>(null);
  useEffect(() => {
    if (!activeProcess) {
      setShown(null);
      return;
    }
    // Restore the persisted pin (context_data.last_shown) so a display mounted
    // AFTER the agent's `flow show` (page reload, late-opened tab) still lands
    // on the deliverable — the on_show entity event has no replay.
    const lastShown = (activeProcess.context_data as { last_shown?: ShowTarget } | undefined)
      ?.last_shown;
    setShown(lastShown ?? null);
    return activeProcess.onShow((payload) => setShown(payload as ShowTarget));
  }, [activeProcess]);

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
    // Fallback (nothing explicitly shown): the artifact-driven WebappViewer,
    // which carries its own chrome — left unwrapped.
    const preview = <WebappViewer onWebappErrorRetry={onRetry} />;

    // A shown viewer under the two-tier toolbar: per-type toolbar (left) +
    // generic "open externally" (right).
    const wrapAsset = (path: string, node: React.ReactNode) => (
      <DisplayToolbar externalUrl={assetExternalUrl(AssetDocPointer.forVfs(editorForPath(path), path))}>
        {node}
      </DisplayToolbar>
    );

    if (shown) {
      switch (shown.kind) {
        case 'webapp':
          if (!webAppConfig.host) return preview;
          return (
            <DisplayToolbar
              externalUrl={webAppConfig.host}
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
                src={webAppConfig.host}
                cacheKey={webAppConfig.cacheKey}
                onErrorRetry={() => onRetry(t`The web app is not working, please try to fix it.`)}
              />
            </DisplayToolbar>
          );
        case 'entity': {
          const editor = shown.type ? editorForType(shown.type) : undefined;
          if (editor && shown.typeid) {
            const ptr = AssetDocPointer.forTypeId(editor, new TypeId(shown.typeid));
            return (
              <DisplayToolbar externalUrl={assetExternalUrl(ptr)}>
                <AssetEditorRouter key={`${ptr.toPointer()}:${refreshStamp}`} pointer={ptr.toPointer()} />
              </DisplayToolbar>
            );
          }
          // Type without a bespoke editor — fall back to the raw file view.
          if (shown.path) return wrapAsset(shown.path, vfsEditorEl(shown.path, refreshStamp));
          break;
        }
        case 'vfs':
          if (shown.path) return wrapAsset(shown.path, vfsEditorEl(shown.path, refreshStamp));
          break;
      }
    }

    switch (focus.viewType) {
      case ViewType.EDITOR:
        return focus.path
          ? wrapAsset(focus.path, <CodeEditor activePath={focus.path} readOnly />)
          : preview;
      case ViewType.DIFF:
        return focus.path ? (
          <DisplayToolbar>
            <DiffViewer checkpoint_hash={focus.path} />
          </DisplayToolbar>
        ) : (
          preview
        );
      case ViewType.WEB_APP:
      default:
        return preview;
    }
  }, [shown, refreshStamp, focus.viewType, focus.path, onRetry, webAppConfig, webappPort, t]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={36} minSize={24} maxSize={55}>
        <EntityExecutionPanel
          target={target}
          processType={ProcessKind.Chat}
          className="h-full border-r border-border"
          dense
          // "New project" (back to VibeHome) sits on the LEFT of the same header
          // row as the session buttons — Vibe has no left rail.
          leadingSlot={
            <button
              type="button"
              onClick={() => navigation.openHome()}
              title={t`New project`}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              {t`New`}
            </button>
          }
          placeholder={t`Describe what to build or change…`}
          emptyStateText={t`Tell the assistant what to build.`}
          newSessionLabel={t`New build`}
          historyLabel={t`Build history`}
          pastSessionsLabel={t`Past builds`}
          noPastSessionsLabel={t`No past builds`}
          defaultProjectId={project?.id ?? null}
          defaultWorkdir={project?.fs_storage_mount_path ?? null}
          onProcessCreated={(p) => p.enableAssistant()}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={64} minSize={45}>
        {displayEl}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default VibeWorkspace;
