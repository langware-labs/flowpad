import { ChevronDown, ChevronUp, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';

const ALL = 'md-find';
const ACTIVE = 'md-find-active';

const BUTTON =
  'flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd+F on Mac, Ctrl+F on Windows/Linux. */
export function isFindShortcut(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && e.key.toLowerCase() === 'f';
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null =>
  (globalThis.CSS as unknown as { highlights?: HighlightRegistry })?.highlights ?? null;
const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

interface MarkdownFindBarProps {
  /** The element whose text is searched. */
  root: HTMLElement | null;
  onClose: () => void;
}

/** Find-in-document bar: highlights matches without touching the document. */
export const MarkdownFindBar: React.FC<MarkdownFindBarProps> = ({ root, onClose }) => {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Recompute matches on query change and when the document re-renders,
  // coalesced to one scan per frame.
  useEffect(() => {
    if (!root || !query) {
      setRanges([]);
      return;
    }
    let frame = 0;
    const run = () => {
      frame = 0;
      setRanges(findRanges(root, query));
    };
    run();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(run);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [root, query]);

  const active = ranges.length ? Math.min(index, ranges.length - 1) : -1;

  useEffect(() => {
    const reg = registry();
    if (!reg || !Highlight) return;
    reg.set(ALL, new Highlight(...ranges));
    return () => reg.delete(ALL);
  }, [ranges]);

  useEffect(() => {
    const reg = registry();
    if (!reg || !Highlight || active < 0) return;
    reg.set(ACTIVE, new Highlight(ranges[active]));
    return () => reg.delete(ACTIVE);
  }, [ranges, active]);

  // Scroll only when the user moves between matches or changes the query.
  const rangesRef = useRef(ranges);
  rangesRef.current = ranges;
  useEffect(() => {
    if (active >= 0) rangesRef.current[active]?.startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  const step = (delta: number) => {
    if (ranges.length) setIndex((active + delta + ranges.length) % ranges.length);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (isFindShortcut(e)) {
      e.preventDefault();
      inputRef.current?.select();
    }
  };

  return (
    <div className="absolute right-3 top-2 z-50 flex items-center gap-1 rounded-md border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur-sm">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder={t`Find in document…`}
        className="h-6 w-48 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-[3rem] text-right text-xs tabular-nums text-muted-foreground">
        {query ? `${active + 1}/${ranges.length}` : ''}
      </span>
      <button
        onClick={() => step(-1)}
        disabled={!ranges.length}
        title={t`Previous match (Shift+Enter)`}
        className={BUTTON}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => step(1)}
        disabled={!ranges.length}
        title={t`Next match (Enter)`}
        className={BUTTON}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        title={t`Close (Escape)`}
        className={BUTTON}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
