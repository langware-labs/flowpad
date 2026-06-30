import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { WebappViewer } from '@src/components/webapp-viewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@src/components/ui/resizable';
import { useAgentContext } from '@src/contexts/agent-context';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { AgenticProcess, dataContext, FlowData, ProcessKind, Project, TypeId, ViewType } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';

interface VibeFocus {
  viewType: ViewType | null;
  path?: string;
  port?: string;
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

  // Feed the focused dev-server port into the viewer store — the exact channel
  // WebappViewer reads (`currentContext.viewerOptions.port`). EDITOR/DIFF get
  // their data via props (below), so only the port needs the store. This is
  // store state, not URL state.
  useEffect(() => {
    if (!focus.viewType) return;
    setCurrentContext({ viewerOptions: focus.port ? { port: focus.port } : {} });
  }, [focus.viewType, focus.port, setCurrentContext]);

  const onRetry = useCallback((msg: string) => void dataContext.agenticProcess?.prompt(msg), []);

  // Preview-first: default to the web app; switch to code/diff when the agent
  // focuses them. Each viewer self-resolves its data (WebappViewer from the
  // store/artifacts, CodeEditor from the path).
  const displayEl = useMemo(() => {
    const preview = <WebappViewer onWebappErrorRetry={onRetry} />;
    switch (focus.viewType) {
      case ViewType.EDITOR:
        return <CodeEditor activePath={focus.path} readOnly />;
      case ViewType.DIFF:
        return focus.path ? <DiffViewer checkpoint_hash={focus.path} /> : preview;
      case ViewType.WEB_APP:
      default:
        return preview;
    }
  }, [focus.viewType, focus.path, onRetry]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={36} minSize={24} maxSize={55}>
        <div className="flex h-full flex-col border-r border-border">
          {/* Slim top bar — Vibe has no left rail, so this is the way back to
              VibeHome to start a fresh build. */}
          <div className="flex h-9 shrink-0 items-center justify-between px-3">
            <span className="text-xs font-medium text-muted-foreground">{t`Build`}</span>
            <button
              type="button"
              onClick={() => navigation.openHome()}
              title={t`New project`}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              {t`New`}
            </button>
          </div>
          <EntityExecutionPanel
            target={target}
            processType={ProcessKind.Chat}
            className="min-h-0 flex-1"
            dense
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
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={64} minSize={45}>
        {displayEl}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default VibeWorkspace;
