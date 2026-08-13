/**
 * useConversationSearch
 *
 * Ctrl+F over an agentic process's CONVERSATION, not the terminal buffer.
 *
 * Why not the terminal: every CLI we host draws a full-screen TUI, so nothing
 * that scrolls out of view is retained by xterm. Claude renders on the
 * ALTERNATE screen (no scrollback by VT spec). Copilot is worse — it pins a
 * header and footer and scrolls only the rows between them via a DECSTBM
 * sub-region (`ESC[3;35r`), and a sub-region scroll DISCARDS the line leaving
 * the top instead of pushing it to scrollback. Measured on a live Copilot
 * session: `buffer.active.length === rows`, i.e. zero scrollback, on both the
 * alternate AND the normal buffer. There is no terminal-side corpus to search.
 *
 * The conversation, however, is already on the client — `flowDataStream`, fed
 * live over WS and backfilled by the idempotent `AgenticProcess.loadHistory()`.
 * That is what we search.
 *
 * Consequence, accepted by design: this finds what the agent SAID, not what the
 * terminal PAINTED. Banners, pinned status lines and raw rows that never became
 * a message are not searchable.
 *
 * Scope is the ACTIVE SESSION. The stream outlives a session — a resumed or
 * restarted process keeps whatever it streamed under the previous session_id —
 * so rows are filtered against `process.session_id`. See `isInSession`.
 */

import { AgenticProcess, FlowData, FlowDataEvents, FlowElementTypes } from '@sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgenticProcessStream } from './use-agentic-process-stream';

/**
 * Element types whose `content` is real conversation prose.
 *
 * Deliberately an allowlist, not a blocklist: a Copilot session's stream is a
 * large majority of empty `{}` STATUS rows minted from session/turn
 * bookkeeping, and unknown live events are dumped as truncated raw JSON. Both
 * are pure noise in a hit list.
 */
const PROSE_TYPES = new Set<string>([
  FlowElementTypes.USER_MESSAGE,
  FlowElementTypes.CHAT,
  FlowElementTypes.TEXT,
  FlowElementTypes.REASONING,
  FlowElementTypes.TOOL_RESULT,
  FlowElementTypes.ERROR,
  FlowElementTypes.WORKER_UNAVAILABLE,
]);

/** Transcript bookkeeping — mirrors `groupTurnEvents.ts`'s NON_ACTIVITY_SUBTYPES. */
const NON_ACTIVITY_SUBTYPES = new Set<string>(['token_usage', 'meta', 'summary']);

/**
 * Fields inside a TOOL_CALL's structured payload that carry human-meaningful
 * text. We index these rather than `JSON.stringify(flow_value)`, which would
 * also match key names — searching "tool" would hit every `"tool_call_id"`.
 */
const TOOL_CALL_TEXT_KEYS = ['command', 'file_path', 'path', 'query', 'pattern', 'description'];

/** No virtualization in this repo by convention, so the list is capped. */
export const MAX_HITS = 200;

const SNIPPET_BEFORE = 32;
const SNIPPET_AFTER = 96;

export interface ConversationHit {
  /** Index into the searched items array — stable for the life of one snapshot. */
  itemIndex: number;
  item: FlowData;
  /** Offset of this occurrence within the item's searchable text. */
  charOffset: number;
  /** One-line excerpt around the match. */
  snippet: string;
  /** Offset of the match WITHIN `snippet`, for highlighting. */
  snippetMatchStart: number;
  /** Short role/tool label for the row chip. */
  label: string;
  isUser: boolean;
}

export interface ConversationSearchResult {
  hits: ConversationHit[];
  /** True when the hit cap clipped the list. */
  truncated: boolean;
  /** True while the one-time history backfill is in flight. */
  loading: boolean;
  /**
   * The searched corpus itself, so a caller can pull the neighbourhood around a
   * hit via `contextWindowFor`. Exposed rather than baked into each hit: at 200
   * hits that would mean 200 redundant slices, and only one row is ever open.
   */
  items: readonly FlowData[];
  /** The session the results are scoped to; null when the process has none. */
  sessionId: string | null;
}

/** One message in an expanded hit's surroundings. */
export interface ContextEntry {
  itemIndex: number;
  item: FlowData;
  isUser: boolean;
  /** True for the message the hit was found in. */
  isMatch: boolean;
}

export const CONTEXT_BEFORE = 2;
export const CONTEXT_AFTER = 2;

function isUserRow(item: FlowData): boolean {
  return item.elementType === FlowElementTypes.USER_MESSAGE || item.attributes?.role === 'user';
}

/**
 * The session a row belongs to, or null when it doesn't say.
 *
 * Replayed rows carry the transcript envelope, whose `session_id` is the
 * authoritative per-row answer (`transcript_analyzer/entry.py` writes it into
 * every `to_dict`). Live rows have no envelope at all.
 */
export function sessionIdOf(item: FlowData): string | null {
  const entry = item.processEntry?.transcript_entry as { session_id?: unknown } | undefined;
  if (entry && typeof entry.session_id === 'string' && entry.session_id) return entry.session_id;
  const attr = item.attributes?.['session-id'];
  return attr || null;
}

/**
 * Whether a row belongs to the session the terminal is currently running.
 *
 * A row that names no session is live — it arrived over the WS from the worker
 * running right now, so it IS the active session by construction. Only a row
 * that names a DIFFERENT session is excluded, which is exactly the leftover a
 * resume/restart leaves behind in the long-lived stream.
 *
 * With no active session id known (a process that has not started one), nothing
 * is filtered — an unknown scope must not silently empty the results.
 */
export function isInSession(item: FlowData, activeSessionId: string | null | undefined): boolean {
  if (!activeSessionId) return true;
  const sid = sessionIdOf(item);
  return sid === null || sid === activeSessionId;
}

export interface SearchScope {
  /** Restrict to this session; omit/null to search every row in the stream. */
  sessionId?: string | null;
}

function labelFor(item: FlowData): string {
  if (isUserRow(item)) return 'user';
  if (item.elementType === FlowElementTypes.TOOL_CALL || item.elementType === FlowElementTypes.TOOL_RESULT) {
    return item.attributes?.['tool-name'] || 'tool';
  }
  if (item.elementType === FlowElementTypes.REASONING) return 'thinking';
  if (item.elementType === FlowElementTypes.ERROR) return 'error';
  return 'agent';
}

/**
 * The text of one row, or '' when the row is not worth indexing.
 *
 * Never reads `processEntry`: on history rows it duplicates `content`, and on
 * live rows it is null — indexing both would double-count every assistant
 * message after a reload and not before it.
 */
export function searchableText(item: FlowData): string {
  const subtype = item.attributes?.subtype;
  if (subtype && NON_ACTIVITY_SUBTYPES.has(subtype)) return '';

  if (item.elementType === FlowElementTypes.TOOL_CALL) {
    const payload = item.data as Record<string, unknown> | null;
    const parts: string[] = [];
    const toolName = item.attributes?.['tool-name'];
    if (toolName) parts.push(toolName);
    const skillName = item.attributes?.['skill-name'];
    if (skillName) parts.push(skillName);
    if (payload && typeof payload === 'object') {
      const input = (payload.input ?? payload.args ?? payload) as Record<string, unknown>;
      if (input && typeof input === 'object') {
        for (const key of TOOL_CALL_TEXT_KEYS) {
          const v = input[key];
          if (typeof v === 'string' && v) parts.push(v);
        }
      }
    }
    return parts.join(' ');
  }

  if (!PROSE_TYPES.has(item.elementType)) return '';

  const text = item.content;
  // Replay mints placeholders with `flow_value={}` for rows whose entry type
  // produces no FlowData; they carry no information at all.
  if (!text || text === '{}' || text === '*no content*') return '';
  return text;
}

function buildSnippet(text: string, at: number, queryLength: number): { snippet: string; matchStart: number } {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + queryLength + SNIPPET_AFTER);
  // Collapse whitespace so a match inside a 200-line answer still renders as
  // one readable row.
  const rawHead = text.slice(start, at);
  const rawMatch = text.slice(at, at + queryLength);
  const rawTail = text.slice(at + queryLength, end);
  const head = (start > 0 ? '…' : '') + rawHead.replace(/\s+/g, ' ');
  const tail = rawTail.replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  return { snippet: head + rawMatch + tail, matchStart: head.length };
}

/**
 * Pure hit finder. Exported for unit tests — keep it free of React and of any
 * dependence on stream internals.
 */
export function findConversationHits(
  items: readonly FlowData[],
  query: string,
  options: SearchScope & { maxHits?: number } = {},
): { hits: ConversationHit[]; truncated: boolean } {
  const { sessionId = null, maxHits = MAX_HITS } = options;
  const hits: ConversationHit[] = [];
  if (!query) return { hits, truncated: false };
  const needle = query.toLowerCase();

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (!isInSession(item, sessionId)) continue;
    const text = searchableText(item);
    if (!text) continue;

    const haystack = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      if (hits.length >= maxHits) return { hits, truncated: true };
      const { snippet, matchStart } = buildSnippet(text, at, query.length);
      hits.push({
        itemIndex,
        item,
        charOffset: at,
        snippet,
        snippetMatchStart: matchStart,
        label: labelFor(item),
        isUser: isUserRow(item),
      });
      from = at + needle.length;
    }
  }
  return { hits, truncated: false };
}

/**
 * The messages surrounding a hit: a couple before, a couple after.
 *
 * Walks outward skipping anything `searchableText` rejects, because the raw
 * neighbours of a message are mostly empty `{}` STATUS bookkeeping — taking
 * `items[i-2..i+2]` verbatim would spend the whole window on rows that render
 * as nothing. Counting only rows that would have been searched means "two
 * before" is two things the user can actually read.
 *
 * The matched message is always included, even if it sits at either end of the
 * conversation and the window is one-sided.
 *
 * Pure and exported for unit tests — keep it free of React.
 */
export function contextWindowFor(
  items: readonly FlowData[],
  itemIndex: number,
  options: SearchScope & { before?: number; after?: number } = {},
): ContextEntry[] {
  const { sessionId = null, before = CONTEXT_BEFORE, after = CONTEXT_AFTER } = options;
  if (itemIndex < 0 || itemIndex >= items.length) return [];

  const entryAt = (i: number, isMatch: boolean): ContextEntry => ({
    itemIndex: i,
    item: items[i],
    isUser: isUserRow(items[i]),
    isMatch,
  });

  // Context never crosses a session boundary — a neighbour from the previous
  // run is not context for this one.
  const readable = (i: number) => isInSession(items[i], sessionId) && !!searchableText(items[i]);

  const head: ContextEntry[] = [];
  for (let i = itemIndex - 1; i >= 0 && head.length < before; i--) {
    if (!readable(i)) continue;
    head.unshift(entryAt(i, false));
  }

  const tail: ContextEntry[] = [];
  for (let i = itemIndex + 1; i < items.length && tail.length < after; i++) {
    if (!readable(i)) continue;
    tail.push(entryAt(i, false));
  }

  return [...head, entryAt(itemIndex, true), ...tail];
}

/**
 * Live search over a process's conversation.
 *
 * Mount this only while the search UI is open — it triggers the history
 * backfill on mount. `loadHistory()` is idempotent (`_historyLoaded` guard plus
 * an in-flight promise), so this costs one request per process, ever, no matter
 * how many times the user opens the bar.
 */
export function useConversationSearch(
  process: AgenticProcess | null | undefined,
  query: string,
): ConversationSearchResult {
  const items = useAgenticProcessStream(process ?? null);
  const [loading, setLoading] = useState(false);

  // One-time backfill so a session opened cold (resumed, or after a refresh)
  // has more than the messages this tab happened to witness live.
  useEffect(() => {
    if (!process) return;
    let cancelled = false;
    setLoading(true);
    void process
      .loadHistory()
      .catch(() => {
        /* leave the corpus at whatever arrived live */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [process]);

  /**
   * A streaming answer is ONE FlowData mutated in place: the stream emits
   * 'data' only when the group OPENS — carrying whatever the first frame held,
   * often a few characters — and every later frame is `appendContent`, which
   * emits CHUNK on the instance and nothing on the stream. The authoritative
   * `complete=true` payload arrives the same way. `FlowDataStream.items` stays
   * memoized throughout, so `useAgenticProcessStream` (which re-emits only on
   * length/identity change) never sees the text grow.
   *
   * Subscribing to the TAIL alone is not enough, and that was the bug: the
   * moment a tool call lands after an open assistant message, the growing row
   * is no longer last, and the rest of that answer never becomes searchable.
   *
   * So every row is subscribed. There is no cheaper filter — `ready` looks like
   * one but is set at construction, so it is true even while a group is open
   * and `appendContent` is still mutating the row. Subscribing is diffed
   * against what is already bound, making it O(rows added) per stream event
   * rather than re-binding the whole conversation each time.
   */
  const [chunkTick, setChunkTick] = useState(0);
  const bound = useRef<Map<FlowData, () => void>>(new Map());
  useEffect(() => {
    const map = bound.current;
    const live = new Set(items);
    for (const [item, handler] of map) {
      // Gone from the stream — cleared, or retracted as an optimistic echo.
      if (live.has(item)) continue;
      item.off(FlowDataEvents.CHUNK, handler);
      map.delete(item);
    }
    for (const item of items) {
      if (map.has(item)) continue;
      const handler = () => setChunkTick((n) => n + 1);
      item.on(FlowDataEvents.CHUNK, handler);
      map.set(item, handler);
    }
  }, [items]);

  // Release every listener on unmount — the search UI is mounted only while the
  // bar is open, but the FlowData rows outlive it on the process.
  useEffect(() => {
    const map = bound.current;
    return () => {
      for (const [item, handler] of map) item.off(FlowDataEvents.CHUNK, handler);
      map.clear();
    };
  }, []);

  const sessionId = process?.session_id ?? null;

  const { hits, truncated } = useMemo(
    () => findConversationHits(items, query, { sessionId }),
    // chunkTick is a deliberate recompute trigger for in-place text growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, query, chunkTick, sessionId],
  );

  return { hits, truncated, loading, items, sessionId };
}
