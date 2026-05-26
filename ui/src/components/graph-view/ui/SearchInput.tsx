import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { EntityIcon } from './EntityIcon';

export type SearchResultRow = {
  key: string;
  label: string;
  type: string;
  id: string;
};

type Props = {
  onQueryChange: (query: string) => SearchResultRow[];
  onSelect: (key: string) => void;
};

function highlight(text: string, q: string) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function SearchInput({ onQueryChange, onSelect }: Props) {
  const [value, setValue] = useState('');
  const [results, setResults] = useState<SearchResultRow[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const next = onQueryChange(value.trim());
      setResults(next);
      setActiveIdx(0);
      setOpen(true);
    }, 200);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [value, onQueryChange]);

  const handleSelect = (row: SearchResultRow) => {
    onSelect(row.key);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="search-wrap">
      <div className="search-input-row">
        <Search size={14} />
        <input
          className="search-input"
          placeholder="Search nodes…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {open && results.length > 0 && (
        <div className="search-dropdown" role="listbox">
          {results.map((row, i) => (
            <div
              key={row.key}
              role="option"
              aria-selected={i === activeIdx}
              className={`search-row ${i === activeIdx ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(row);
              }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="icon"><EntityIcon type={row.type} size={14} /></span>
              <span className="body">
                <div className="label">{highlight(row.label, value)}</div>
                <div className="meta">{row.type} · {row.id.slice(0, 8)}</div>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
