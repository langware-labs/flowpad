import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { SearchFilters } from '@src/hooks/use-record-search';
import { cn } from '@src/lib/utils';
import { RecordType } from '@sdk';
import { CornerDownLeft, Search, SlidersHorizontal, X } from 'lucide-react';
import { KeyboardEvent, useCallback, useRef, useState } from 'react';

const RECORD_TYPES = [
  'bookmark', 'claude_session', RecordType.SKILL, RecordType.AGENT, 'claude_hook', RecordType.COMMAND,
  RecordType.ANNOTATION, 'comment', RecordType.TASK, 'workflow', RecordType.MARKDOWN, RecordType.PLAN,
  RecordType.CLAUDE_MD, 'claude_memory', 'claude_rules', RecordType.PROJECT,
];
const TIME_PRESETS = [
  { value: '1h', label: '1h' },
  { value: '1d', label: '1d' },
  { value: '1w', label: '1w' },
  { value: 'custom', label: 'Custom' },
] as const;
const STATUSES = ['active', 'closed', 'archived'];

const TYPE_DISPLAY_NAMES: Record<string, string> = {
  claude_session: 'session',
  claude_hook: 'hook',
};

const TYPE_COLORS: Record<string, string> = {
  bookmark: 'bg-violet-500/20 text-violet-700 dark:text-violet-300',
  claude_session: 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  skill: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  agent: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
  claude_hook: 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  command: 'bg-rose-500/20 text-rose-700 dark:text-rose-300',
  annotation: 'bg-sky-500/20 text-sky-700 dark:text-sky-300',
  comment: 'bg-teal-500/20 text-teal-700 dark:text-teal-300',
  task: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300',
  workflow: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-300',
  docs: 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
  plan: 'bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300',
  claude_md: 'bg-lime-500/20 text-lime-700 dark:text-lime-300',
  claude_memory: 'bg-pink-500/20 text-pink-700 dark:text-pink-300',
  claude_rules: 'bg-red-500/20 text-red-700 dark:text-red-300',
  project: 'bg-purple-500/20 text-purple-700 dark:text-purple-300',
  asset: 'bg-stone-500/20 text-stone-700 dark:text-stone-300',
};

interface RecordSearchBarProps {
  /** Compact mode: filters hidden by default */
  compact?: boolean;
  /** Show the Tools toggle button (default: false) */
  showTools?: boolean;
  placeholder?: string;
  query: string;
  filters: SearchFilters;
  onQueryChange: (q: string) => void;
  onFiltersChange: (f: SearchFilters) => void;
  onClearAll?: () => void;
  onSubmit?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}

function CustomDateRangeInputs({
  filters,
  onFiltersChange,
}: {
  filters: SearchFilters;
  onFiltersChange: (f: SearchFilters) => void;
}) {
  const toDateValue = (iso?: string) => iso ? iso.slice(0, 10) : '';
  return (
    <>
      <input
        type="date"
        value={toDateValue(filters.time_start)}
        onChange={(e) => onFiltersChange({ ...filters, time_start: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
        className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
        placeholder="Start"
      />
      <span className="text-muted-foreground">–</span>
      <input
        type="date"
        value={toDateValue(filters.time_end)}
        onChange={(e) => onFiltersChange({ ...filters, time_end: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
        className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
        placeholder="End"
      />
    </>
  );
}

export function RecordSearchBar({
  compact = true,
  showTools = false,
  placeholder = 'Search records...',
  query,
  filters,
  onQueryChange,
  onFiltersChange,
  onClearAll,
  onSubmit,
  onKeyDown: onKeyDownProp,
  className,
}: RecordSearchBarProps) {
  const [showFilters, setShowFilters] = useState(!compact);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      onKeyDownProp?.(e);
      if (e.key === 'Enter') {
        e.preventDefault();
        onSubmit?.();
      }
    },
    [onSubmit, onKeyDownProp],
  );

  const toggleType = (type: string) => {
    const current = filters.record_type;
    onFiltersChange({ ...filters, record_type: current === type ? undefined : type });
  };

  const toggleStatus = (status: string) => {
    const current = filters.status;
    onFiltersChange({ ...filters, status: current === status ? undefined : status });
  };

  const toggleTime = (preset: string) => {
    const current = filters.time_preset;
    if (current === preset) {
      onFiltersChange({ ...filters, time_preset: undefined, time_start: undefined, time_end: undefined });
    } else {
      onFiltersChange({ ...filters, time_preset: preset as SearchFilters['time_preset'], time_start: undefined, time_end: undefined });
    }
  };

  const clearQuery = () => {
    onQueryChange('');
    inputRef.current?.focus();
  };

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="record-search-bar">
      {/* Search input row */}
      <div className="flex items-center gap-1 rounded-md border bg-accent/30 px-3 py-1.5 focus-within:ring-1 focus-within:ring-ring">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />

        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="h-auto flex-1 border-none bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid="search-input"
        />

        {query && (
          <button
            type="button"
            onClick={clearQuery}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}

        {showTools && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 gap-1 px-2 text-xs text-muted-foreground',
              showFilters && 'bg-muted text-foreground',
            )}
            onClick={() => setShowFilters((v) => !v)}
            data-testid="search-tools-btn"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Tools
          </Button>
        )}

        {onSubmit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-muted-foreground hover:text-foreground"
            onClick={onSubmit}
            aria-label="Search"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs"
          data-testid="search-filter-panel"
        >
          {/* Type row */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 w-10 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
              Type
            </span>
            {RECORD_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors',
                  filters.record_type === t
                    ? (TYPE_COLORS[t] ?? 'bg-primary/20 text-primary')
                    : 'border border-border/50 bg-background text-muted-foreground hover:bg-muted hover:border-border',
                )}
              >
                {TYPE_DISPLAY_NAMES[t] ?? t}
                {filters.record_type === t && ' ✕'}
              </button>
            ))}
          </div>

          {/* Horizontal divider */}
          <div className="h-px bg-border/50" />

          {/* Status + Time + Clear All row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Status filter */}
            <div className="flex items-center gap-1">
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Status
              </span>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  className={cn(
                    'rounded px-1.5 py-0.5 transition-colors',
                    filters.status === s
                      ? 'bg-primary/20 text-primary'
                      : 'border border-border/50 bg-background text-muted-foreground hover:bg-muted hover:border-border',
                  )}
                >
                  {s}
                  {filters.status === s && ' ✕'}
                </button>
              ))}
            </div>

            <div className="h-4 w-px bg-border/70" />

            {/* Time filter */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Time
              </span>
              {TIME_PRESETS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleTime(value)}
                  className={cn(
                    'rounded px-1.5 py-0.5 transition-colors',
                    filters.time_preset === value
                      ? 'bg-primary/20 text-primary'
                      : 'border border-border/50 bg-background text-muted-foreground hover:bg-muted hover:border-border',
                  )}
                >
                  {label}
                  {filters.time_preset === value && ' ✕'}
                </button>
              ))}
              {filters.time_preset === 'custom' && (
                <CustomDateRangeInputs filters={filters} onFiltersChange={onFiltersChange} />
              )}
            </div>

            <div className="h-4 w-px bg-border/70" />

            <button
              type="button"
              onClick={onClearAll ?? (() => onFiltersChange({}))}
              className="text-muted-foreground hover:text-foreground"
            >
              Clear All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
