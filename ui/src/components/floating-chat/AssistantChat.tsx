import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { NewSessionPill } from '@src/components/entity-execution-panel/NewSessionPill';
import { useAgentContext } from '@src/contexts/agent-context';
import { AskForHelpButton } from '@src/components/help/AskForHelpButton';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { useEntityBreadcrumbs } from '@src/components/top-nav-bar/use-entity-breadcrumbs';
import { DockPointer } from '@src/navigation/DockPointer';
import { ProcessKind } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantContextChips } from './AssistantContextChips';
import { assistantContextInstructions, assistantContextKey } from './assistant-context';
import type { PendingAsk } from './FloatingChatContext';
import { useFlowpadAssistantProject } from './useFlowpadAssistantProject';

/** Rapid tab flips settle to the last one before the assistant looks it up. */
const FOLLOW_SETTLE_MS = 250;

// EXPERIMENT: PTY-transcript chat transport. Set
// `localStorage.setItem('flowpad.experiment.ptyChat', '1')` (and reload) to
// drive the assistant through a PTY worker whose FlowData is derived by
// polling the session transcript, with the stream closing on inactivity.
const PTY_CHAT_EXPERIMENT_KEY = 'flowpad.experiment.ptyChat';

export function loadPtyChatExperiment(): boolean {
  try {
    return localStorage.getItem(PTY_CHAT_EXPERIMENT_KEY) === '1';
  } catch {
    return false;
  }
}

interface Bound {
  key: string;
  dock: DockPointer | null;
}

/** Is the user mid-sentence in this assistant's composer? A switch waits for them. */
function isTypingIn(container: HTMLElement | null): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  return !!(container && el instanceof HTMLTextAreaElement && container.contains(el) && el.value.trim() !== '');
}

/**
 * The Flowpad Assistant chat — one chat per dock context — shared by the
 * floating window and the popped-out window.
 *
 * `followedDock` is where the user is. The chat shown ("bound") follows it
 * under three rules:
 *   1. only while `visible` — a closed/hidden assistant does no follow work;
 *   2. only onto a context that already HAS a chat (or when the current one is
 *      still empty) — browsing never creates a chat; "New chat for this page"
 *      and `pendingAsk` do;
 *   3. always quietly — no focus steal, and never while the user is typing.
 */
export function AssistantChat({
  followedDock,
  visible,
  pendingAsk,
  onAskConsumed,
  initialDock,
  onBoundChange,
}: {
  followedDock: DockPointer | null;
  visible: boolean;
  pendingAsk: PendingAsk | null;
  onAskConsumed: (nonce: number) => void;
  /** The chat to open on (a popout continues the chat that was showing). */
  initialDock?: DockPointer | null;
  /** Reports the page whose chat is showing. */
  onBoundChange?: (dock: DockPointer | null) => void;
}) {
  const { t } = useLingui();
  const { project: assistantProject, target, isLoading } = useFlowpadAssistantProject();
  // Help is asked about where the user is — their project, not the assistant's.
  const { project: userProject } = useAgentContext();
  const [ptyExperiment] = useState<boolean>(() => loadPtyChatExperiment());
  const containerRef = useRef<HTMLDivElement | null>(null);

  // The same live query the panel runs (same name → one subscription), so
  // browsing costs no request: the lookup below is an in-memory filter.
  const { processes } = useProcessesForTarget(target ?? '', { processType: ProcessKind.Chat, enabled: !!target });

  // Where the user is, settled. Not tracked at all while hidden (rule 1).
  const [followed, setFollowed] = useState<Bound | null>(null);
  const followedKey = visible ? assistantContextKey(followedDock) : null;
  useEffect(() => {
    if (!visible || followedKey === null) return;
    const id = setTimeout(() => setFollowed({ key: followedKey, dock: followedDock }), FOLLOW_SETTLE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key IS the dock's identity here
  }, [visible, followedKey]);

  const [bound, setBound] = useState<Bound | null>(() =>
    initialDock ? { key: assistantContextKey(initialDock), dock: initialDock } : null,
  );
  useEffect(() => {
    onBoundChange?.(bound?.dock ?? null);
  }, [bound, onBoundChange]);
  // Re-checked when the composer loses focus, so a switch deferred for typing lands.
  const [blurTick, setBlurTick] = useState(0);

  const hasChat = useCallback((key: string) => processes.some((p) => p.context_key === key), [processes]);

  // An ask is for the page it was made on: bind there first (a remount keyed
  // on the context), then hand it to the panel as its auto-prompt.
  const askUrl = pendingAsk?.url ?? null;
  const askBound = useMemo<Bound | null>(() => {
    if (!askUrl) return null;
    const dock = DockPointer.fromUrl(askUrl);
    return { key: assistantContextKey(dock), dock };
  }, [askUrl]);

  // Each page the user settles on is decided ONCE — switch or stay — so a
  // later bind (an ask, "New chat for this page") is never undone by an old
  // follow decision. Only a switch deferred for typing is retried (on blur).
  const decidedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (askBound) {
      if (askBound.key !== bound?.key) setBound(askBound);
      decidedKeyRef.current = followed?.key ?? null;
      return;
    }
    if (!followed || followed.key === decidedKeyRef.current) return;
    if (followed.key === bound?.key) {
      decidedKeyRef.current = followed.key;
      return;
    }
    if (!bound) {
      decidedKeyRef.current = followed.key;
      setBound(followed);
      return;
    }
    // Rule 2: stay on the chat you have unless the page has its own — an empty
    // current chat has nothing to keep.
    if (!hasChat(followed.key) && hasChat(bound.key)) {
      decidedKeyRef.current = followed.key;
      return;
    }
    // Rule 3: never swap the conversation out from under a sentence.
    if (isTypingIn(containerRef.current)) return;
    decidedKeyRef.current = followed.key;
    setBound(followed);
  }, [askBound, followed, bound, hasChat, blurTick]);
  const autoPrompt =
    pendingAsk && askBound && askBound.key === bound?.key
      ? { text: pendingAsk.text, files: pendingAsk.files, nonce: pendingAsk.nonce }
      : null;
  // The panel's own effect (a child) has fired by the time this one runs.
  useEffect(() => {
    if (autoPrompt) onAskConsumed(autoPrompt.nonce);
  }, [autoPrompt?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const { crumbs } = useEntityBreadcrumbs(bound?.dock ?? null);
  const processContext = useMemo(
    () => ({
      instructions: assistantContextInstructions(bound?.dock ?? null, crumbs),
      contextData: { assistant_dock_url: bound?.dock?.toUrl() ?? null },
    }),
    [bound?.dock, crumbs],
  );

  const elsewhere = !!(followed && bound && followed.key !== bound.key);

  if (!target) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {isLoading ? <Trans>Loading Flowpad Assistant…</Trans> : <Trans>Flowpad Assistant project not available.</Trans>}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBlurTick((n) => n + 1);
      }}
      data-testid="assistant-chat"
      data-context-key={bound?.key ?? ''}
    >
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-2 py-1">
        <AssistantContextChips crumbs={crumbs} className="flex-1" />
        {elsewhere && (
          <button
            type="button"
            className="flex-shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => followed && setBound(followed)}
            data-testid="assistant-new-chat-here"
          >
            <Trans>New chat for this page</Trans>
          </button>
        )}
      </div>
      {bound && (
        <EntityExecutionPanel
          // One panel per context: its picker, local process and draft are all
          // about that context's chat.
          key={bound.key}
          target={target}
          processType={ProcessKind.Chat}
          contextKey={bound.key}
          processContext={processContext}
          autoPrompt={autoPrompt}
          className="h-full"
          emptyStateText={t`Ask the Flowpad Assistant anything about this page.`}
          // Vibe's header, same UX: "+ New" · "Recent" · ask-for-help, on the left.
          leadingSlot={({ startNewSession }) => <NewSessionPill onClick={startNewSession} title={t`New chat`} />}
          historyTriggerLabel={t`Recent`}
          historyOnLeft
          afterHistorySlot={({ activeProcess }) => (
            <AskForHelpButton
              // Hidden → no project → its live task query is off.
              projectId={visible ? (userProject?.id ?? null) : null}
              sessionTypeId={activeProcess?.typeId ?? null}
              origin="assistant"
            />
          )}
          historyLabel={t`Chat history`}
          pastSessionsLabel={t`Past chats`}
          noPastSessionsLabel={t`No past chats`}
          placeholder={t`What can flowpad do for you ?`}
          allowAttachments
          dense
          // Pin newly-spawned chat processes to the Flowpad Assistant project so
          // the asset manager and workdir are sourced from the assistant — not
          // whatever project the user happens to have active in the dock.
          defaultProjectId={assistantProject?.id ?? null}
          defaultWorkdir={assistantProject?.fs_storage_mount_path ?? null}
          transport={ptyExperiment ? 'pty-poll' : 'print'}
        />
      )}
    </div>
  );
}
