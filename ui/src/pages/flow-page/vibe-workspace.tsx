import type { ShowTarget } from '@sdk';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { DisplayToolbar } from '@src/components/display-toolbar';
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@src/components/ui/resizable';
import { useAgentContext } from '@src/contexts/agent-context';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForPath } from '@src/navigation/asset-doc-types';
import { DisplayHistoryButton } from './display-history-button';
import { AgenticProcess, type DisplayEntry, FlowData, ViewType } from '@sdk';
import {dockForDisplayTarget} from '@src/navigation/display-target-pointer';

import { openActiveDisplay } from '@src/navigation/open-active-display';
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
import {displayAnnotationContextForDock, displayAnnotationContextForPath, type DisplayAnnotationContext} from './display-annotation';

import { submitDisplayAnnotation } from './display-annotation-submit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface VibeFocus {
  viewType: ViewType | null;
  path?: string;
}

/**
 * Read the most-recent agent `focus` off the AgenticProcess stream (`focus`,
 * `data.path`) — the involuntary per-write focus the display FALLS BACK to when
 * nothing is addressed. Deliberately not URL state: it changes many times per
 * turn, so routing it would spam navigation.
 */
function useVibeFocus(items: FlowData[]): VibeFocus {
  return useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.focus) {
        const d = it.data as { path?: string } | undefined;
        return { viewType: it.focus, path: d?.path ?? it.attributes?.path };
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
 * URL the display body is `ContentPanel` under `DisplayChrome` — a running app
 * included, addressed by what serves it. What is left in this file is the pane
 * for what has no address — the involuntary `focus` stream fallback and the empty
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
  // Bumped on every `flow show` — even a re-show of the SAME target, which is a
  // no-op navigation (same URL) yet may sit behind a rebuild. It is the display
  // body's content epoch, which is what reloads it.
  const [showNonce, setShowNonce] = useState(0);
  // The payload of the newest show — see `DisplayChrome.latestShown`.
  const [latestShown, setLatestShown] = useState<ShowTarget | null>(null);

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
      // Not addressable (a type with no editor and no path) is a real answer: the
      // target still lands in the display history, and the pane stays as it is.
      if (committed) hasPushedDisplayRef.current = true;
    });
  }, [activeProcess, navigation, session.processDock.pointer, projectId, currentDock]);

  // Open a past display as its OWN standard tab (the reusable behavior): convert
  // the stored target to its dock pointer and navigate.
  const onOpenHistoryEntry = useCallback(
    (entry: DisplayEntry) => {
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
  // branches carry it: the pane (the focus fallback, the empty state) and the
  // URL-addressed child. The stack is the same server-side history
  // either way — it belongs to the workspace, not to whichever viewer is up.
  const historySlot = useMemo(
    () => <DisplayHistoryButton stack={displayStack} onOpen={onOpenHistoryEntry} />,
    [displayStack, onOpenHistoryEntry],
  );


  // The pane's own viewers (the focus fallback) keep an annotate
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

  // Display precedence: an explicit `flow show` target is a URL (rendered by the
  // child branch below); on the display URL itself, stream focus (write/diff
  // noise) and then the empty state.
  // Live refresh: remount the shown content when the agent's turn ends — every
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
    // Nothing on the display URL but the stream focus. `nothing shown` no longer
    // implies an empty history: an addressed target lives in the URL, so the pane
    // legitimately sits empty while the workspace has a rich show history behind it
    // (the user clicked the Display home chip, or a redirect has not run). The
    // history popover is workspace chrome, not viewer chrome, so it must survive
    // that — otherwise stepping back to the Display home silently loses the way
    // back into the stack.
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
    const empty = displayStack.length ? <DisplayToolbar historySlot={historySlot}>{starter}</DisplayToolbar> : starter;

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

    switch (focus.viewType) {
      case ViewType.EDITOR:
        return focus.path ? wrapAsset(focus.path, <CodeEditor activePath={focus.path} readOnly />) : empty;
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
          empty
        );
      }
      default:
        // A running app is an address now (`flow show` navigated to it), so the
        // focus stream has nothing else this pane can render.
        return empty;
    }
  }, [
    historySlot,
    displayStack,
    focus.viewType,
    focus.path,
    t,
    navigation,
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
                {/* A re-show AND the agent's turn end both mean "what is shown may
                    have changed behind the same address" — see `contentEpoch`. */}
                <ContentPanel minimalChrome contentEpoch={showNonce + refreshStamp} />
              </DisplayChrome>
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default VibeWorkspace;
