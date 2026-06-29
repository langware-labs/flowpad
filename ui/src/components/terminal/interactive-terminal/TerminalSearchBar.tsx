import { ChevronDown, ChevronUp, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchAddon } from '@xterm/addon-search';
import { useLingui } from '@lingui/react/macro';

interface TerminalSearchBarProps {
  searchAddon: SearchAddon | null;
  onClose: () => void;
}

export const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({ searchAddon, onClose }) => {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const findNext = useCallback(() => {
    if (!searchAddon || !query) return;
    searchAddon.findNext(query, { caseSensitive: false, incremental: false });
  }, [searchAddon, query]);

  const findPrevious = useCallback(() => {
    if (!searchAddon || !query) return;
    searchAddon.findPrevious(query, { caseSensitive: false, incremental: false });
  }, [searchAddon, query]);

  // Incremental search as user types
  useEffect(() => {
    if (!searchAddon) return;
    if (query) {
      searchAddon.findNext(query, { caseSensitive: false, incremental: true });
    } else {
      // Clear highlights when query is empty
      searchAddon.clearActiveDecoration();
    }
  }, [searchAddon, query]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      e.shiftKey ? findPrevious() : findNext();
    }
  };

  return (
    <div className="absolute right-3 top-2 z-50 flex items-center gap-1 rounded-md border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur-sm">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t`Search terminal…`}
        className="h-6 w-48 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
      <button
        onClick={findPrevious}
        disabled={!query}
        title={t`Previous match (Shift+Enter)`}
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={findNext}
        disabled={!query}
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
  );
};
