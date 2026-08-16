import { ChevronDown, ChevronUp, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlowElementTypes, type AgenticProcess, type FlowData } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import ExecutionMessage from '@src/components/entity-execution-panel/execution-message/execution-message';
import { ToolEntryRow } from '@src/components/floating-chat/ToolEntryRow';
import {
  contextWindowFor,
  useConversationSearch,
  type ContextEntry,
  type ConversationHit,
} from '@src/hooks/use-conversation-search';

interface ConversationSearchOverlayProps {
  process: AgenticProcess;
  onClose: () => void;
}

/** Highlight every occurrence of `query` in `text`.
 *
 *  Deliberately local to this component — see the plan's non-goals: no shared
 *  helper, and the existing copies elsewhere in the app are left alone. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let from = 0;
  let key = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark
        key={key++}
        className="rounded-sm bg-yellow-200 px-0.5 text-yellow-900 dark:bg-yellow-800/60 dark:text-yellow-200"
      >
        {text.slice(at, at + query.length)}
      </mark>,
    );
    from = at + query.length;
  }
  out.push(text.slice(from));
  return out;
}

/**
 * A row the chat renders as a tool chip rather than as prose.
 *
 * `ExecutionMessage` has no tool branch — it markdown-renders `content` under an
 * assistant identity row. On a TOOL_RESULT that means the raw tool output
 * attributed to the agent as if it had said it, and on a TOOL_CALL it means
 * nothing at all, because a call's payload lives in `data` and `content` is
 * empty (the component returns null on empty content). Both go to the chip.
 */
function isToolRow(item: FlowData): boolean {
  return item.elementType === FlowElementTypes.TOOL_CALL || item.elementType === FlowElementTypes.TOOL_RESULT;
}

/** One rendered row of an expanded hit's context. */
interface ContextRow {
  key: number;
  entries: ContextEntry[];
  isTool: boolean;
  /** True when the searched-for match is in this row. */
  isMatch: boolean;
}

/**
 * Partition a context window into rendered rows: prose one-per-entry, and
 * CONSECUTIVE tool rows merged into one.
 *
 * The merge is what lets `ToolEntryRow` pair a call with its result via
 * `pairToolEvents` — handed a lone TOOL_RESULT it can only render the
 * "tool result (no matching call)" fallback, which is the raw reading this
 * replaces. Mirrors how `groupTurnEvents` feeds the same component in the chat
 * panes, minus the grouper's stream bookkeeping: a context window is a fixed
 * five-row slice, not a live stream.
 */
function groupContextRows(context: readonly ContextEntry[]): ContextRow[] {
  const rows: ContextRow[] = [];
  for (const entry of context) {
    const isTool = isToolRow(entry.item);
    const open = rows[rows.length - 1];
    if (isTool && open?.isTool) {
      open.entries.push(entry);
      open.isMatch = open.isMatch || entry.isMatch;
      continue;
    }
    rows.push({ key: entry.itemIndex, entries: [entry], isTool, isMatch: entry.isMatch });
  }
  return rows;
}

/**
 * Ctrl+F for an agentic-process terminal.
 *
 * Searches the CONVERSATION rather than the xterm buffer, because no CLI we
 * host leaves anything in that buffer to search — see `use-conversation-search`
 * for the measurements. Nothing here touches the terminal: it is not scrolled,
 * not written to, and not navigated away from. Hits are read in place.
 */
export const ConversationSearchOverlay: React.FC<ConversationSearchOverlayProps> = ({ process, onClose }) => {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { hits, truncated, loading, items, sessionId } = useConversationSearch(process, query);

  /** Only the open row's surroundings are built — see `contextWindowFor`. */
  const expandedContext = useMemo(() => {
    const hit = expanded === null ? undefined : hits[expanded];
    return hit ? contextWindowFor(items, hit.itemIndex, { sessionId }) : [];
  }, [expanded, hits, items, sessionId]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // A new query invalidates any prior selection/expansion.
  useEffect(() => {
    setSelected(hits.length > 0 ? 0 : -1);
    setExpanded(null);
  }, [query, hits.length]);

  const worker = process.worker_type ?? undefined;

  const select = useCallback(
    (index: number) => {
      if (hits.length === 0) return;
      const next = ((index % hits.length) + hits.length) % hits.length;
      setSelected(next);
      rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
    },
    [hits.length],
  );

  const findNext = useCallback(() => select(selected + 1), [select, selected]);
  const findPrevious = useCallback(() => select(selected - 1), [select, selected]);

  /** Focus moves into the list so Enter means "expand this row" rather than
   *  "next hit" — the two Enter meanings are separated by focus, not by mode. */
  const focusRow = useCallback(
    (index: number) => {
      if (hits.length === 0) return;
      const next = ((index % hits.length) + hits.length) % hits.length;
      setSelected(next);
      rowRefs.current[next]?.focus();
    },
    [hits.length],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrevious();
      else findNext();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(selected + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(selected - 1);
    }
  };

  const onRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded((cur) => (cur === index ? null : index));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (index === hits.length - 1) {
        inputRef.current?.focus();
      } else {
        focusRow(index + 1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0) {
        inputRef.current?.focus();
      } else {
        focusRow(index - 1);
      }
    }
  };

  const counter = useMemo(() => {
    if (!query) return '';
    if (hits.length === 0) return t`0`;
    return `${selected + 1}/${hits.length}${truncated ? '+' : ''}`;
  }, [query, hits.length, selected, truncated, t]);

  return (
    <div
      data-testid="conversation-search-overlay"
      className="absolute right-3 top-2 z-50 flex max-h-[70%] w-[28rem] flex-col rounded-md border border-border bg-background/95 shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <input
          ref={inputRef}
          data-testid="conversation-search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={t`Search conversation…`}
          className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{counter}</span>
        <button
          onClick={findPrevious}
          disabled={hits.length === 0}
          title={t`Previous match (Shift+Enter)`}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={findNext}
          disabled={hits.length === 0}
          title={t`Next match (Enter)`}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          title={t`Close (Escape)`}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {query && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {hits.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {loading ? t`Loading conversation…` : t`No matches in this conversation`}
            </div>
          ) : (
            hits.map((hit, i) => (
              <ConversationHitRow
                key={`${hit.itemIndex}-${hit.charOffset}`}
                ref={(el: HTMLDivElement | null) => {
                  rowRefs.current[i] = el;
                }}
                hit={hit}
                query={query}
                worker={worker}
                selected={i === selected}
                expanded={expanded === i}
                context={expanded === i ? expandedContext : undefined}
                onKeyDown={(e) => onRowKeyDown(e, i)}
                onClick={() => {
                  setSelected(i);
                  setExpanded((cur) => (cur === i ? null : i));
                }}
              />
            ))
          )}
          {truncated && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              {t`Showing the first ${hits.length} matches — narrow the search to see the rest.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface ConversationHitRowProps {
  hit: ConversationHit;
  query: string;
  worker?: string;
  selected: boolean;
  expanded: boolean;
  /** The matched message plus its neighbours; only supplied while expanded. */
  context?: ContextEntry[];
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onClick: () => void;
}

const ConversationHitRow = React.forwardRef<HTMLDivElement, ConversationHitRowProps>(
  ({ hit, query, worker, selected, expanded, context, onKeyDown, onClick }, ref) => {
    const rows = useMemo(() => (context ? groupContextRows(context) : []), [context]);
    return (
      <div
        ref={ref}
        data-testid="conversation-search-result"
        tabIndex={-1}
        role="option"
        aria-selected={selected}
        onKeyDown={onKeyDown}
        onClick={onClick}
        className={`cursor-pointer border-b border-border/50 px-2 py-1.5 outline-none ${
          selected ? 'bg-accent text-foreground' : 'hover:bg-accent/50'
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
            {hit.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs">{highlight(hit.snippet, query)}</span>
        </div>
        {expanded && rows.length > 0 && (
          // The matched message reads in its surroundings: a couple of messages
          // before and after, dimmed, with the match itself at full contrast and
          // rail-marked so it stays findable once the block is scrolled.
          <div
            data-testid="conversation-search-context"
            className="mt-1.5 max-h-64 space-y-1 overflow-y-auto rounded border border-border bg-background/60 p-1"
          >
            {rows.map((row) => (
              <div
                key={row.key}
                data-testid={row.isMatch ? 'conversation-search-context-match' : 'conversation-search-context-nearby'}
                className={
                  row.isMatch ? 'rounded-sm border-l-2 border-primary bg-background/70 pl-1.5' : 'pl-1.5 opacity-60'
                }
                // A chip is interactive — expanding it must not toggle the hit
                // row shut underneath.
                onClick={row.isTool ? (e) => e.stopPropagation() : undefined}
              >
                {row.isTool ? (
                  <ToolEntryRow events={row.entries.map((entry) => entry.item)} />
                ) : (
                  <ExecutionMessage flowData={row.entries[0].item} isUser={row.entries[0].isUser} worker={worker} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);
ConversationHitRow.displayName = 'ConversationHitRow';
