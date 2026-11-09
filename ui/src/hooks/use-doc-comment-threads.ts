import { Comment, QueryRequest, TypeId } from '@sdk';
import { useAuth } from '@src/hooks/useAuth';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useCallback, useMemo } from 'react';
import type { FormValue, MessageForm } from '@src/components/conversation/message-form';

/**
 * A doc's comment threads — `Comment` entities whose `data` is a `doc.comment`
 * value (`flow_sdk/schema/data_spec/doc_comment_spec.py`): a person's note, an
 * agent's questions (a form), or a change request — each anchored to a quote.
 * A reply is a comment on the same doc naming its root in `reply_to` (a doc child,
 * so it syncs with the doc). Answers and status changes are replies too — the latest
 * one wins — because on a shared doc only a comment's author may edit it. Line-gutter comments (`{line}`)
 * stay with `useDocComments`.
 */
export type DocCommentKind = 'text' | 'questions' | 'change_request';
export type DocCommentStatus = 'open' | 'sent' | 'done' | 'failed' | 'resolved';

export interface ChatLink {
  process_id: string;
  at: string;
}

export interface DocCommentReply {
  id: string;
  text: string;
  author: string | null;
  chat: ChatLink | null;
  createdAt: string;
}

export interface DocThread {
  /** `comment-<uuid>` */
  id: string;
  kind: DocCommentKind;
  status: DocCommentStatus;
  author: string | null;
  quote: string;
  text: string;
  form: MessageForm | null;
  answers: Record<string, FormValue> | null;
  instruction: string | null;
  replies: DocCommentReply[];
  createdAt: string;
}

const stamp = (c: Comment) => (c.created_date instanceof Date ? c.created_date.toISOString() : String(c.created_date ?? ''));

/** Threads (oldest first) out of every comment the doc's scope query returned. */
export function buildThreads(raw: readonly Comment[], docKey: string): DocThread[] {
  const roots: DocThread[] = [];
  const byId = new Map<string, DocThread>();
  for (const c of raw) {
    const d = c.data ?? {};
    if (c.parent_type_id !== docKey || !d.kind || !d.anchor?.quote) continue;
    const t: DocThread = {
      id: c.typeId.toString(),
      kind: d.kind,
      status: d.status ?? 'open',
      author: d.author ?? null,
      quote: d.anchor.quote,
      text: c.raw_content ?? '',
      form: d.form ?? null,
      answers: d.answers?.values ?? null,
      instruction: d.change?.instruction ?? null,
      replies: [],
      createdAt: stamp(c),
    };
    roots.push(t);
    byId.set(t.id, t);
  }
  const events = raw
    .filter((c) => c.parent_type_id === docKey && c.data?.reply === true && byId.has(c.data.reply_to))
    .sort((a, b) => stamp(a).localeCompare(stamp(b)));
  for (const c of events) {
    const root = byId.get(c.data!.reply_to)!;
    if (c.data!.status) root.status = c.data!.status;
    if (c.data!.answers) root.answers = c.data!.answers.values ?? null;
    if (c.data!.anchor?.quote) root.quote = c.data!.anchor.quote;
    // A bare status or answers change is not a message in the thread.
    if (!c.raw_content) continue;
    root.replies.push({
      id: c.typeId.toString(),
      text: c.raw_content,
      author: c.data!.author ?? null,
      chat: c.data!.chat ?? null,
      createdAt: stamp(c),
    });
  }
  return roots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function useDocCommentThreads(docTypeId: string | null | undefined) {
  const { currentUser } = useAuth();
  const me = currentUser?.name || currentUser?.email || null;
  const parent = useMemo(() => {
    if (!docTypeId) return null;
    try {
      return new TypeId(docTypeId);
    } catch {
      return null;
    }
  }, [docTypeId]);
  const docKey = parent?.toString() ?? null;

  // The scope query is permissive — it returns comments of every parent — so the
  // replies of this doc's threads come back with it; buildThreads sorts them out.
  const request = useMemo(
    () => new QueryRequest({ type: 'comment', scope: parent ? [parent] : [], name: 'useDocCommentThreads' }),
    [parent],
  );
  const { data: raw = [], refetch } = useEntitiesQuery<Comment>(request, { enabled: !!parent });
  const threads = useMemo(() => (docKey ? buildThreads(raw, docKey) : []), [raw, docKey]);

  const addThread = useCallback(
    async (kind: DocCommentKind, quote: string, text: string, body: { instruction?: string; form?: MessageForm } = {}) => {
      if (!parent || !docKey || !quote.trim()) return;
      const data: Record<string, unknown> = { kind, status: 'open', anchor: { quote: quote.trim() } };
      if (me) data.author = me;
      if (body.instruction) data.change = { instruction: body.instruction };
      if (body.form) data.form = body.form;
      await new Comment({ raw_content: text, parent_type_id: docKey, data }).save(parent);
      await refetch();
    },
    [parent, docKey, me, refetch],
  );

  /** Post into threads — a message, and/or a new status or answers — then read once. */
  const post = useCallback(
    async (threads: readonly DocThread[], text: string, extra: Record<string, unknown> = {}) => {
      if (!parent || !docKey || threads.length === 0) return;
      await Promise.all(
        threads.map((thread) => {
          const data: Record<string, unknown> = { reply: true, reply_to: thread.id, ...extra };
          if (me) data.author = me;
          return new Comment({ raw_content: text, parent_type_id: docKey, data }).save(parent);
        }),
      );
      await refetch();
    },
    [parent, docKey, me, refetch],
  );

  const reply = useCallback((thread: DocThread, text: string) => (text.trim() ? post([thread], text.trim()) : Promise.resolve()), [post]);

  const setStatus = useCallback((threads: readonly DocThread[], status: DocCommentStatus) => post(threads, '', { status }), [post]);

  const answer = useCallback(
    (thread: DocThread, values: Record<string, FormValue>) =>
      thread.form ? post([thread], '', { answers: { form_id: thread.form.form_id, values } }) : Promise.resolve(),
    [post],
  );

  /** The quoted passage was rewritten: the thread sits on its new text from now on, for everyone. */
  const reanchor = useCallback((thread: DocThread, quote: string) => post([thread], '', { anchor: { quote } }), [post]);

  return { threads, addThread, reply, setStatus, answer, reanchor, refetch };
}
