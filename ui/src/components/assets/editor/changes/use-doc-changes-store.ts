import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** One queued "change this" request: the selected text and what to do with it. */
export interface DocChange {
  id: string;
  quote: string;
  from: number;
  to: number;
  instruction: string;
  /** Set once Execute handed this change to a worker. */
  sent?: boolean;
}

/**
 * A doc's list. `sentTo` names the worker running the sent changes; marks made
 * while it runs stay unsent and go out with the next Execute.
 */
export interface DocChangeList {
  changes: DocChange[];
  sentTo?: string;
  /** The worker was launched for this list, so its first idle `complete` is the run done. */
  fresh?: boolean;
  /** The worker was seen busy after the send — its next idle is the run done. */
  started?: boolean;
  /** The worker this doc's changes last went to — Execute reuses it (outlives the run). */
  worker?: string;
  /** The last run did not finish — the panel offers to retry in a new session. */
  lastFailed?: boolean;
  /** Counts Execute presses on this list, so a turn's end can tell whether more was sent behind it. */
  batch?: number;
}

interface DocChangesState {
  /** Keyed by the doc's TypeId string — one list per doc. */
  byDoc: Record<string, DocChangeList>;
  add: (doc: string, change: Omit<DocChange, 'id' | 'sent'>) => void;
  remove: (doc: string, id: string) => void;
  /** Drop every change (the Clear button). */
  clear: (doc: string) => void;
  /** Mark the unsent changes as handed to `processId`. */
  markSent: (doc: string, processId: string, fresh: boolean) => void;
  markStarted: (doc: string) => void;
  /** The run finished: drop the sent changes, keep marks made meanwhile. */
  finishRun: (doc: string) => void;
  /** The run failed: the sent changes go back to unsent, ready to retry. */
  failRun: (doc: string) => void;
}

const EMPTY: DocChangeList = { changes: [] };

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function put(s: DocChangesState, doc: string, list: DocChangeList): Pick<DocChangesState, 'byDoc'> {
  if (list.changes.length === 0 && !list.sentTo && !list.worker) {
    const rest = { ...s.byDoc };
    delete rest[doc];
    return { byDoc: rest };
  }
  return { byDoc: { ...s.byDoc, [doc]: list } };
}

export const useDocChangesStore = create<DocChangesState>()(
  persist(
    (set) => ({
      byDoc: {},
      add: (doc, change) =>
        set((s) => {
          const list = s.byDoc[doc] ?? EMPTY;
          return put(s, doc, { ...list, changes: [...list.changes, { ...change, id: newId() }] });
        }),
      remove: (doc, id) =>
        set((s) => {
          const list = s.byDoc[doc];
          if (!list) return s;
          return put(s, doc, { ...list, changes: list.changes.filter((c) => c.id !== id) });
        }),
      clear: (doc) => set((s) => put(s, doc, { changes: [], worker: s.byDoc[doc]?.worker })),
      markSent: (doc, processId, fresh) =>
        set((s) => {
          const list = s.byDoc[doc] ?? EMPTY;
          const changes = list.changes.map((c) => (c.sent ? c : { ...c, sent: true }));
          return put(s, doc, {
            changes,
            sentTo: processId,
            worker: processId,
            fresh,
            started: false,
            batch: (list.batch ?? 0) + 1,
          });
        }),
      markStarted: (doc) =>
        set((s) => {
          const list = s.byDoc[doc];
          if (!list?.sentTo || list.started) return s;
          return put(s, doc, { ...list, started: true });
        }),
      finishRun: (doc) =>
        set((s) => {
          const list = s.byDoc[doc];
          if (!list) return s;
          return put(s, doc, { changes: list.changes.filter((c) => !c.sent), worker: list.worker });
        }),
      failRun: (doc) =>
        set((s) => {
          const list = s.byDoc[doc];
          if (!list) return s;
          return put(s, doc, {
            changes: list.changes.map((c) => ({ ...c, sent: false })),
            lastFailed: true,
            worker: list.worker,
          });
        }),
    }),
    { name: 'doc-change-requests' },
  ),
);

/** The doc's list (stable empty list when there is none). */
export function useDocChangeList(doc: string | null): DocChangeList {
  return useDocChangesStore((s) => (doc ? s.byDoc[doc] : undefined) ?? EMPTY);
}

/** The changes Execute would send now. */
export function unsentChanges(list: DocChangeList): DocChange[] {
  return list.changes.filter((c) => !c.sent);
}
