import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { ClipboardList, ExternalLink, Loader2, MessageSquare, MessagesSquare, WandSparkles } from 'lucide-react';
import { AgenticProcess, dataContext, ProcessKind } from '@sdk';
import apiClient from '@sdk/client';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import type { CommentLayer, RequestChangeOpts, RequestedChange } from '@src/components/milkdown-editor/MilkdownEditor';
import { commentSlot, usePlacedComments } from '@src/components/milkdown-editor/plugins/comment-widgets';
import { FieldControl } from '@src/components/conversation/MessageFormCard';
import { initialValues, leftToFill, type FormValue } from '@src/components/conversation/message-form';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { settleVerdict } from '@src/components/assets/editor/changes/useDocChangesWorker';
import { useLastWorkerType } from '@src/components/terminal/openers/useLastWorkerType';
import { useDocCommentThreads, type DocThread } from '@src/hooks/use-doc-comment-threads';
import { useCurrentDock, useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer, TRANSCRIPT_TIME_PARAM } from '@src/navigation/DockPointer';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { mostRecentProcess } from '@src/utils/process-recency';
import { useDocChangesStore } from '@src/components/assets/editor/changes/use-doc-changes-store';
import { buildCommentsPrompt, isReady } from './send';

const COMMENTS_SIDE_TAB_ID = 'comments';

/** The thread the side panel shows — set by a card's 💬, read by the panel. */
const useSelectedThread = create<{ id: string | null; select: (id: string | null) => void }>((set) => ({
  id: null,
  select: (id) => set({ id }),
}));

const INPUT =
  'w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const BADGE = 'inline-block rounded-full px-1.5 py-px text-[10px] leading-4';
const STATUS: Record<string, [() => string, string]> = {
  open: [() => t`Open`, 'bg-primary/15 text-primary'],
  sent: [() => t`Sent`, 'bg-amber-500/15 text-amber-600 dark:text-amber-400'],
  done: [() => t`Done`, 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'],
  failed: [() => t`Failed`, 'bg-destructive/15 text-destructive'],
  resolved: [() => t`Resolved`, 'bg-muted text-muted-foreground'],
};

function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? STATUS.open;
  return (
    <span className={cn(BADGE, cls)} data-testid="comment-status">
      {label()}
    </span>
  );
}

const kindIcon = (k: DocThread['kind']) => (k === 'questions' ? ClipboardList : k === 'change_request' ? WandSparkles : MessageSquare);
const kindLabel = (th: DocThread) =>
  th.kind === 'questions' ? `${t`Questions`} · ${th.form?.title ?? ''}` : th.kind === 'change_request' ? t`Change request` : t`Comment`;
const authorLabel = (a: string | null) => (a === 'agent' ? t`Agent` : (a ?? t`Someone`));

/** Scroll the doc to a thread's card and flash it. */
function showInDoc(id: string) {
  const el = commentSlot(id);
  if (!el.isConnected) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flowpad-comment-flash');
  void el.offsetWidth;
  el.classList.add('flowpad-comment-flash');
}

function Reply({ r, onOpenChat }: { r: DocThread['replies'][number]; onOpenChat: (chat: NonNullable<DocThread['replies'][number]['chat']>) => void }) {
  return (
    <div className="mt-2 border-t border-border/50 pt-2" data-testid="comment-reply">
      <div className={cn('mb-0.5 text-xs font-semibold', r.author === 'agent' ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground')}>
        {authorLabel(r.author)}
      </div>
      <div className="text-[13px] leading-5 text-foreground">
        {r.text}
        {r.chat && (
          <button
            type="button"
            onClick={() => onOpenChat(r.chat!)}
            className="ms-1.5 inline-flex items-center gap-0.5 text-xs text-primary underline underline-offset-4"
            data-testid="comment-open-in-chat"
          >
            {t`Open in chat`} <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A thread drawn in the doc, after the passage it quotes. */
function CommentCard({
  thread,
  readyCount,
  sending,
  onOpen,
  onSend,
  onOpenChat,
}: {
  thread: DocThread;
  readyCount: number;
  sending: boolean;
  onOpen: () => void;
  /** Send every ready comment; `values` are this card's answers, saved first. */
  onSend: (values?: Record<string, FormValue>) => void;
  onOpenChat: (chat: { process_id: string; at: string }) => void;
}) {
  const Icon = kindIcon(thread.kind);
  const form = thread.form;
  const editable = thread.status === 'open' || thread.status === 'failed';
  const [values, setValues] = useState<Record<string, FormValue>>(() => thread.answers ?? {});
  const answersKey = JSON.stringify(thread.answers ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setValues(form ? initialValues(form, thread.answers ? { form_id: form.form_id, values: thread.answers } : null) : {}), [answersKey]);
  const missing = form ? leftToFill(form, values) : [];
  const dirty = form ? JSON.stringify(values) !== answersKey : false;
  const lastReply = thread.replies.filter((r) => r.author === 'agent').at(-1);

  return (
    <div
      className="max-w-[640px] rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground"
      data-testid="doc-comment-card"
      data-comment-kind={thread.kind}
      data-comment-id={thread.id}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs">
        <Icon className="h-3.5 w-3.5" />
        <span className="font-semibold">{authorLabel(thread.author)}</span>
        <span className="text-muted-foreground">· {kindLabel(thread)}</span>
        <span className="ms-auto" />
        <StatusBadge status={thread.status} />
        <button
          type="button"
          onClick={onOpen}
          title={t`Open the thread`}
          className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
          data-testid="doc-comment-open"
        >
          <MessagesSquare className="h-3 w-3" /> {thread.replies.length + 1}
        </button>
      </div>
      {thread.text && <div className="mb-1 text-[13px]">{thread.text}</div>}
      {thread.kind === 'change_request' && <div className="text-[13px]">{thread.instruction}</div>}
      {form &&
        form.fields.map((f) => (
          <div key={f.id} className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-2 border-t border-border/50 py-1.5 first-of-type:border-t-0" data-testid={`form-field-${f.id}`}>
            <label className="pt-1 text-foreground/85" htmlFor={`${thread.id}-${f.id}`}>
              {f.label}
              {f.optional && <span className="ms-1 text-[10px] text-muted-foreground">{t`optional`}</span>}
            </label>
            <div className="flex flex-wrap items-center gap-1">
              <FieldControl
                field={f}
                id={`${thread.id}-${f.id}`}
                value={values[f.id]}
                disabled={!editable}
                onChange={(v) =>
                  setValues((prev) => {
                    const next = { ...prev };
                    if (v === undefined) delete next[f.id];
                    else next[f.id] = v;
                    return next;
                  })
                }
                onFile={() => {}}
              />
            </div>
          </div>
        ))}
      {lastReply && <Reply r={lastReply} onOpenChat={onOpenChat} />}
      {editable && (form || thread.kind === 'change_request') && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={sending || missing.length > 0 || (readyCount === 0 && !(form && dirty))}
            onClick={() => onSend(form && dirty ? values : undefined)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
            data-testid="doc-comments-send"
          >
            {sending && <Loader2 className="h-3 w-3 animate-spin" />}
            {t`Send to agent`}
          </button>
          <span className={cn('text-xs', missing.length ? 'text-destructive' : 'text-muted-foreground')} data-testid="doc-comment-hint">
            {missing.length
              ? t`${missing.length} left to fill: ${missing.join(', ')}`
              : t`Sends every ready comment on this doc as one turn.`}
          </span>
        </div>
      )}
    </div>
  );
}

function CommentsPanel({
  threads,
  selected,
  onSelect,
  onReply,
  onResolve,
  onOpenChat,
}: {
  threads: readonly DocThread[];
  selected: string | null;
  onSelect: (id: string) => void;
  onReply: (thread: DocThread, text: string) => Promise<void>;
  onResolve: (thread: DocThread) => void;
  onOpenChat: (chat: { process_id: string; at: string }) => void;
}) {
  const [draft, setDraft] = useState('');
  const placed = usePlacedComments((st) => st.ids);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2" data-testid="comments-panel">
      {threads.length === 0 && (
        <div className="px-1 text-[11px] text-muted-foreground">{t`No comments yet. Select text and press the wand to ask for a change.`}</div>
      )}
      {threads.map((th) => {
        const open = th.id === selected;
        const Icon = kindIcon(th.kind);
        const gone = th.status !== 'resolved' && !placed.has(th.id);
        return (
          <div
            key={th.id}
            className={cn('rounded-md border p-2 text-sm', open ? 'border-primary' : 'border-border')}
            data-testid="comment-thread"
            data-comment-id={th.id}
          >
            <button type="button" className="flex w-full items-center gap-1.5 text-start text-xs" onClick={() => onSelect(th.id)}>
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="font-semibold">{authorLabel(th.author)}</span>
              <span className="truncate text-muted-foreground">· {kindLabel(th)}</span>
              <span className="ms-auto" />
              <StatusBadge status={th.status} />
            </button>
            <div className="mt-1 line-clamp-2 border-s-2 border-border ps-2 text-xs italic text-muted-foreground">“{th.quote}”</div>
            {gone && <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400" data-testid="comment-quote-gone">{t`The quoted text is no longer in the doc.`}</div>}
            {open && (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={gone}
                    onClick={() => showInDoc(th.id)}
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] text-primary hover:bg-muted disabled:opacity-45"
                    data-testid="comment-show-in-doc"
                  >
                    ↧ {t`Show in doc`}
                  </button>
                  {th.status !== 'resolved' && (
                    <button type="button" onClick={() => onResolve(th)} className="text-[11px] text-muted-foreground hover:underline" data-testid="comment-resolve">
                      {t`Resolve`}
                    </button>
                  )}
                </div>
                {th.text && <div className="mt-2 text-[13px]">{th.text}</div>}
                {th.instruction && <div className="mt-2 text-[13px]">{th.instruction}</div>}
                {th.replies.map((r) => (
                  <Reply key={r.id} r={r} onOpenChat={onOpenChat} />
                ))}
                <form
                  className="mt-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = draft;
                    setDraft('');
                    void onReply(th, text);
                  }}
                >
                  <input className={INPUT} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t`Reply…`} data-testid="comment-reply-input" />
                </form>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A doc's comments: drawn in the doc after the passage each one quotes, listed
 * in the Comments side tab, and sent — every ready one, as one turn — to the
 * Vibe session the doc is shown in, else to the doc's own worker opened in Vibe.
 */
export function useDocCommentsLayer(doc: string | null, docName: string, docFile: string, onRunFinished?: () => void) {
  const { threads, addThread, reply, setStatus, answer, reanchor, refetch } = useDocCommentThreads(doc);
  const { open: openSideWindow } = useSideWindows();
  const { navigation } = useDockNavigation();
  const dock = useCurrentDock();
  const { lastWorker } = useLastWorkerType();
  const selected = useSelectedThread((s) => s.id);
  const select = useSelectedThread((s) => s.select);
  const [sending, setSending] = useState(false);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  /** Threads this page sent: it re-anchors those whose passage the agent rewrote. */
  const sentHere = useRef(new Set<string>());
  const { processes } = useProcessesForTarget(doc, { enabled: !!doc, processType: ProcessKind.Analysis });
  const hostId = dock?.hostProcessId ? DockPointer.extractAgenticProcessId(dock.hostProcessId) : null;
  const ready = useMemo(() => threads.filter(isReady), [threads]);

  const openThread = useCallback(
    (id: string) => {
      select(id);
      openSideWindow(COMMENTS_SIDE_TAB_ID);
    },
    [select, openSideWindow],
  );

  const openChat = useCallback(
    (chat: { process_id: string; at: string }) => {
      if (!dock) return;
      if (hostId === chat.process_id) navigation.openDock(dock.withOption(TRANSCRIPT_TIME_PARAM, chat.at));
      else void navigation.openDocInChat(dock.withHost(null), chat.process_id, dataContext.project?.id ?? null);
    },
    [dock, hostId, navigation],
  );

  const send = useCallback(async (answered?: { thread: DocThread; values: Record<string, FormValue> }) => {
    if (!doc || !dock || sending) return;
    // A card's fresh answers are saved first and go in this same turn.
    const batch = answered
      ? [...ready.filter((th) => th.id !== answered.thread.id), { ...answered.thread, answers: answered.values }]
      : ready;
    if (batch.length === 0) return;
    setSending(true);
    try {
      if (answered) await answer(answered.thread, answered.values);
      const prompt = buildCommentsPrompt(doc, docName, docFile, batch);
      const projectId = dataContext.project?.id ?? null;
      let process: AgenticProcess | null = null;
      let launched = false;
      if (hostId) {
        process = AgenticProcess.getByIdFromCache(hostId) ?? (await AgenticProcess.getById(hostId));
      } else {
        // Not in Vibe: the doc's own worker, opened in Vibe with the doc beside it.
        process = mostRecentProcess(processes) ?? null;
        if (!process) {
          const workdir = dataContext.project?.fs_storage_mount_path ?? undefined;
          if (!workdir) {
            notify.error({ title: t`No active project`, message: t`Open a project to send these comments.` });
            return;
          }
          process = await AgenticProcess.launch({
            workerType: lastWorker ?? 'claude_code',
            workdir,
            projectId: projectId ?? undefined,
            launchPrompt: prompt,
            enableAssistant: true,
            processType: ProcessKind.Analysis,
            sharedContextEntities: [doc],
            target: doc,
          });
          launched = true;
        }
        await navigation.openDocInChat(dock, process.id, projectId);
      }
      if (!process) throw new Error('the session to send to is gone');
      for (const th of batch) sentHere.current.add(th.id);
      await setStatus(batch, 'sent');
      if (launched) return; // a fresh worker got it as its launch prompt; it reports in the threads
      const queued = process.busy === true || process.isPrompting;
      const target = process;
      void target
        .promptOrEnqueue(prompt)
        .then(async () => {
          // A queued turn is reported on by the agent itself. A streamed one that ended
          // without the agent marking a thread is decided by the server's verdict.
          if (queued) return;
          const fresh = await apiClient.get(`/api/v1/graph/agentic_process/${target.id}`).catch(() => null);
          const verdict = fresh ? settleVerdict(fresh as Parameters<typeof settleVerdict>[0]) : 'failed';
          await refetch();
          const unreported = batch.filter((th) => threadsRef.current.find((x) => x.id === th.id)?.status === 'sent');
          if (verdict !== 'running') await setStatus(unreported, verdict === 'done' ? 'done' : 'failed');
          onRunFinished?.();
        })
        .catch((err) => {
          console.error('[doc-comments] send failed', err);
          notify.error({ title: t`Failed to send the comments` });
          void setStatus(batch, 'failed');
        });
    } catch (err) {
      console.error('[doc-comments] send failed', err);
      notify.error({ title: t`Failed to send the comments` });
    } finally {
      setSending(false);
    }
  }, [doc, dock, ready, sending, docName, docFile, hostId, processes, lastWorker, navigation, answer, setStatus, refetch, onRunFinished]);

  const byId = useMemo(() => new Map(threads.map((th) => [th.id, th])), [threads]);
  const marks = useMemo(() => threads.filter((th) => th.status !== 'resolved').map((th) => ({ id: th.id, quote: th.quote })), [threads]);
  const commentLayer = useMemo<CommentLayer>(
    () => ({
      marks,
      renderCard: (id) => {
        const th = byId.get(id);
        return th ? (
          <CommentCard
            thread={th}
            readyCount={ready.length}
            sending={sending}
            onOpen={() => openThread(id)}
            onSend={(values) => void send(values ? { thread: th, values } : undefined)}
            onOpenChat={openChat}
          />
        ) : null;
      },
    }),
    [marks, byId, ready.length, sending, openThread, send, openChat],
  );

  // A thread this page sent whose passage the agent rewrote moves to the new text —
  // posted once, by the sender only, so it stays put after a reload and for everyone.
  const moved = usePlacedComments((st) => st.moved);
  useEffect(() => {
    for (const th of threads) {
      const text = moved[th.id]?.trim();
      if (!text || text === th.quote || !sentHere.current.has(th.id)) continue;
      sentHere.current.delete(th.id); // one re-anchor per send
      void reanchor(th, text);
    }
  }, [moved, threads, reanchor]);

  // Change requests this browser queued before they were comments: move them over once.
  useEffect(() => {
    if (!doc) return;
    const store = useDocChangesStore.getState();
    const queued = (store.byDoc[doc]?.changes ?? []).filter((c) => !c.sent);
    if (queued.length === 0) return;
    store.clear(doc);
    for (const c of queued) void addThread('change_request', c.quote, '', { instruction: c.instruction });
  }, [doc, addThread]);

  // The wand: a change request is a comment on the selected text.
  const onRequestChange = useCallback(
    async (change: RequestedChange, opts?: RequestChangeOpts) => {
      await addThread('change_request', change.quote, '', { instruction: change.instruction });
      openSideWindow(COMMENTS_SIDE_TAB_ID);
      if (opts?.runNow) void send();
    },
    [addThread, openSideWindow, send],
  );

  const open = threads.filter((th) => th.status !== 'resolved' && th.status !== 'done').length;
  const commentsTab = useMemo<ExtraSideTab>(
    () => ({
      id: COMMENTS_SIDE_TAB_ID,
      label: open > 0 ? `${t`Comments`} ${open}` : t`Comments`,
      icon: MessagesSquare,
      description: t`Comments on this doc`,
      availableInNonAdvanced: true,
      panel: (
        <CommentsPanel
          threads={threads}
          selected={selected}
          onSelect={(id) => select(id === selected ? null : id)}
          onReply={reply}
          onResolve={(th) => void setStatus([th], 'resolved')}
          onOpenChat={openChat}
        />
      ),
    }),
    [open, threads, selected, select, reply, setStatus, openChat],
  );

  return doc
    ? { commentLayer, commentsTab, onRequestChange: (c: RequestedChange, o?: RequestChangeOpts) => void onRequestChange(c, o) }
    : { commentLayer: undefined, commentsTab: null, onRequestChange: undefined };
}
