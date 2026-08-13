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
  maxHits: number = MAX_HITS,
): { hits: ConversationHit[]; truncated: boolean } {
  const hits: ConversationHit[] = [];
  if (!query) return { hits, truncated: false };
  const needle = query.toLowerCase();

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
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
  before: number = CONTEXT_BEFORE,
  after: number = CONTEXT_AFTER,
): ContextEntry[] {
  if (itemIndex < 0 || itemIndex >= items.length) return [];

  const entryAt = (i: number, isMatch: boolean): ContextEntry => ({
    itemIndex: i,
    item: items[i],
    isUser: isUserRow(items[i]),
    isMatch,
  });

  const head: ContextEntry[] = [];
  for (let i = itemIndex - 1; i >= 0 && head.length < before; i--) {
    if (!searchableText(items[i])) continue;
    head.unshift(entryAt(i, false));
  }

  const tail: ContextEntry[] = [];
  for (let i = itemIndex + 1; i < items.length && tail.length < after; i++) {
    if (!searchableText(items[i])) continue;
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
   * A streaming answer is ONE FlowData mutated in place: `appendContent` emits
   * CHUNK on the instance and does NOT emit 'data' on the stream, and
   * `FlowDataStream.items` stays memoized until it does. So
   * `useAgenticProcessStream` — which re-emits only on length/identity change —
   * never sees text growing inside an already-listed message. Without this,
   * searching mid-turn silently misses everything after the first frame.
   */
  const [chunkTick, setChunkTick] = useState(0);
  const tail = items.length > 0 ? items[items.length - 1] : null;
  const tailRef = useRef<FlowData | null>(null);
  tailRef.current = tail;
  useEffect(() => {
    if (!tail) return;
    const onChunk = () => setChunkTick((n) => n + 1);
    tail.on(FlowDataEvents.CHUNK, onChunk);
    return () => {
      tail.off(FlowDataEvents.CHUNK, onChunk);
    };
  }, [tail]);

  const { hits, truncated } = useMemo(
    () => findConversationHits(items, query),
    // chunkTick is a deliberate recompute trigger for in-place text growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, query, chunkTick],
  );

  return { hits, truncated, loading, items };
}
