import { ActionInfo, dataContext, dataManager } from '@sdk';
import type { HookEventData } from '@sdk/claude_hook_events/hook-event-data';
import { getEventSummaryLine } from '@sdk/claude_hook_events/field-extractors';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { CHIP, truncate } from '@src/components/hooks/event-summaries';
import { EVENT_TYPE_COLORS } from '@src/components/hooks/event-utils';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { cn } from '@src/lib/utils';
import { shellQuote, useOpenTerminal } from '@src/hooks/use-open-terminal';
import { Check, ChevronDown, ChevronRight, Copy, FolderOpen, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CliLogEntry {
  id: string;
  type: string;
  created_at: string;
  workdir: string;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  stdin: string | null;
  level: string;
  duration_ms: number;
}

interface ParsedCommand {
  binary: string;
  subcommands: string[];
  flags: { key: string; value: string | true }[];
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Alias for formatTimeAgo that accepts a required string (CliLogEntry.created_at is always set). */
const timeAgo = (iso: string): string => formatTimeAgo(iso) || 'just now';

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function shortenPath(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 2) return filePath;
  return '\u2026/' + parts.slice(-2).join('/');
}

function getComputeNodeId(): string | null {
  return dataContext.computeNode?.typeId?.id ?? null;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

function parseCommand(argv: string[]): ParsedCommand {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { binary: '', subcommands: [], flags: [] };
  }

  const binary = argv[0];
  const subcommands: string[] = [];
  const flags: { key: string; value: string | true }[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags.push({ key: arg.slice(2, eqIdx), value: arg.slice(eqIdx + 1) });
      } else {
        flags.push({ key: arg.slice(2), value: true });
      }
    } else if (arg.startsWith('-')) {
      flags.push({ key: arg.slice(1), value: true });
    } else {
      subcommands.push(arg);
    }
  }

  return { binary, subcommands, flags };
}

function shortenBinary(binary: string): string {
  if (!binary) return '';
  const parts = binary.split('/');
  return parts[parts.length - 1] || binary;
}

// ---------------------------------------------------------------------------
// Stdin parsing (hook JSON data)
// ---------------------------------------------------------------------------

function tryParseHookData(stdin: string | null): HookEventData | null {
  if (!stdin) return null;
  try {
    const parsed = JSON.parse(stdin);
    if (typeof parsed === 'object' && parsed !== null && 'hook_event_name' in parsed) {
      return parsed as HookEventData;
    }
  } catch {
    // not JSON
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {/* ignore */});
  };

  return (
    <button onClick={copy} className="flex-shrink-0 text-muted-foreground hover:text-foreground">
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function CopyableField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-medium text-muted-foreground">{label}:</span>
      <span className="min-w-0 flex-1 truncate font-mono">{value}</span>
      <CopyButton value={value} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CliLogViewer
// ---------------------------------------------------------------------------

export function CliLogViewer() {
  const [entries, setEntries] = useState<CliLogEntry[]>([]);
  const [settingsLevel, setSettingsLevel] = useState('info');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const { openTerminal } = useOpenTerminal();

  const fetchEntries = useCallback(async () => {
    const cnId = getComputeNodeId();
    if (!cnId) return;
    try {
      const action = new ActionInfo('fs-records', 'compute_node', cnId, 'GET');
      action.subpath = 'cli_log';
      action.queryParameters = { limit: '800' };
      const data = await dataManager.callAction<unknown, CliLogEntry[]>(action);
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    const cnId = getComputeNodeId();
    if (!cnId) return;
    try {
      const action = new ActionInfo('fs-records', 'compute_node', cnId, 'GET');
      action.subpath = 'cli_log_settings/local';
      const data = await dataManager.callAction<unknown, { level?: string }>(action);
      if (data?.level) setSettingsLevel(data.level);
    } catch {
      // ignore
    }
  }, []);

  const updateLevel = useCallback(async (level: string) => {
    const cnId = getComputeNodeId();
    if (!cnId) return;
    try {
      const action = new ActionInfo('fs-records', 'compute_node', cnId, 'PUT');
      action.subpath = 'cli_log_settings/local';
      action.bodyParameters = { level };
      action.queryParameters = { _: '1' };
      await dataManager.callAction(action);
      setSettingsLevel(level);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchEntries();
    void fetchSettings();
  }, [fetchEntries, fetchSettings]);

  const handleRefresh = () => {
    setLoading(true);
    void fetchEntries();
  };

  const handleClear = useCallback(async () => {
    const cnId = getComputeNodeId();
    if (!cnId) return;
    try {
      const action = new ActionInfo('clear-cli-log', 'compute_node', cnId, 'POST');
      await dataManager.callAction(action);
      setEntries([]);
      setSelectedIdx(null);
    } catch {
      // ignore
    }
  }, []);

  const selected = selectedIdx !== null ? entries[selectedIdx] : null;

  const handleReplay = useCallback(
    async (entry: CliLogEntry) => {
      const cmd = Array.isArray(entry.command) ? entry.command.join(' ') : String(entry.command);
      const fullCmd = entry.stdin ? `echo ${shellQuote(entry.stdin)} | ${cmd}` : cmd;
      await openTerminal({ command: fullCmd, cwd: entry.workdir });
    },
    [openTerminal],
  );

  if (loading && entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">CLI Invocation Log</span>
        <Badge variant="secondary" className="text-[10px]">
          {entries.length}
        </Badge>

        <div className="ml-auto flex items-center gap-1">
          {/* Level toggle */}
          {(['info', 'debug'] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => void updateLevel(lvl)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                settingsLevel === lvl
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
            >
              {lvl}
            </button>
          ))}

          <div className="mx-1 h-4 w-px bg-muted-foreground/30" />

          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleRefresh}>
            <RefreshCw className="h-3 w-3" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={() => void handleClear()}
            disabled={entries.length === 0}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-auto">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No log entries. Run a <code className="mx-1 rounded bg-muted px-1">flow</code> command to see entries here.
          </div>
        ) : (
          <>
            {entries.map((entry, i) => (
              <div key={entry.id || i}>
                <EntryRow
                  entry={entry}
                  index={i}
                  isSelected={selectedIdx === i}
                  onClick={() => setSelectedIdx(selectedIdx === i ? null : i)}
                />
                {selectedIdx === i && selected && <EntryDetail entry={selected} onReplay={handleReplay} />}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EntryRow — compact one-liner with parsed command chips
// ---------------------------------------------------------------------------

function EntryRow({
  entry,
  index,
  isSelected,
  onClick,
}: {
  entry: CliLogEntry;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}) {
  const parsed = useMemo(() => parseCommand(entry.command), [entry.command]);
  const nameFlag = parsed.flags.find((f) => f.key === 'name');
  const hookData = useMemo(() => tryParseHookData(entry.stdin), [entry.stdin]);
  const hookSummary = useMemo(() => (hookData ? getEventSummaryLine(hookData) : null), [hookData]);

  return (
    <div
      className={cn(
        'flex cursor-pointer items-center gap-1.5 border-b px-3 py-1.5 text-xs transition-colors hover:bg-muted/50',
        isSelected && 'bg-muted',
      )}
      onClick={onClick}
    >
      {/* Index */}
      <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground/50">{index + 1}</span>

      {isSelected ? (
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      )}

      {/* Binary name */}
      <Badge variant="outline" className={`${CHIP} opacity-50`}>
        {shortenBinary(parsed.binary)}
      </Badge>

      {/* Subcommands as badges */}
      {parsed.subcommands.map((sub, i) => (
        <Badge key={i} variant="outline" className={CHIP}>
          {sub}
        </Badge>
      ))}

      {/* Key param: --name */}
      {nameFlag && typeof nameFlag.value === 'string' && (
        <Badge variant="secondary" className={CHIP}>
          {nameFlag.value}
        </Badge>
      )}

      {/* Hook event type badge */}
      {hookData?.hook_event_name && (
        <Badge
          variant="outline"
          className={cn(CHIP, EVENT_TYPE_COLORS[hookData.hook_event_name] ?? 'text-muted-foreground')}
        >
          {hookData.hook_event_name}
        </Badge>
      )}

      {/* Hook event summary */}
      {hookSummary && (
        <span className="max-w-[180px] truncate text-[10px] text-muted-foreground">{hookSummary}</span>
      )}

      <span className="flex-1" />

      {/* Exit code badge */}
      <Badge
        variant={entry.exit_code === 0 ? 'secondary' : 'destructive'}
        className="text-[10px]"
      >
        {entry.exit_code}
      </Badge>

      {entry.level === 'debug' && (
        <span className="text-[10px] text-muted-foreground">debug</span>
      )}

      <span className="text-[10px] text-muted-foreground">{entry.duration_ms}ms</span>

      <span className="text-[10px] text-muted-foreground" title={entry.created_at}>
        {timeAgo(entry.created_at)}
      </span>

      <WorkdirTooltip workdir={entry.workdir} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkdirTooltip — info icon with full path tooltip + copy
// ---------------------------------------------------------------------------

function WorkdirTooltip({ workdir }: { workdir: string }) {
  const [copied, setCopied] = useState(false);

  if (!workdir) return null;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(workdir).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {/* ignore */});
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={copy} className="flex-shrink-0 text-muted-foreground hover:text-foreground">
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <FolderOpen className="h-3 w-3" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <span className="font-mono text-xs">{workdir}</span>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// EntryDetail — expanded view with parsed command & structured stdin
// ---------------------------------------------------------------------------

function EntryDetail({
  entry,
  onReplay,
}: {
  entry: CliLogEntry;
  onReplay: (entry: CliLogEntry) => Promise<void>;
}) {
  const parsed = useMemo(() => parseCommand(entry.command), [entry.command]);
  const hookData = useMemo(() => tryParseHookData(entry.stdin), [entry.stdin]);

  return (
    <div className="border-b bg-muted/30 px-4 py-3 text-xs">
      <div className="flex flex-col gap-2">
        {/* Command breakdown */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground">command:</span>
            <CopyButton value={Array.isArray(entry.command) ? entry.command.join(' ') : String(entry.command)} />
          </div>

          {/* Binary path */}
          <div className="ml-3 flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">bin:</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help font-mono text-muted-foreground">
                  {shortenBinary(parsed.binary)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="font-mono text-xs">{parsed.binary}</span>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Flags as structured key-value badges */}
          {parsed.flags.length > 0 && (
            <div className="ml-3 flex flex-wrap items-center gap-1">
              {parsed.flags.map((flag, i) => (
                <Badge key={i} variant="outline" className="text-[10px]">
                  {flag.value === true ? (
                    <span className="font-mono">--{flag.key}</span>
                  ) : (
                    <>
                      <span className="font-mono text-muted-foreground">{flag.key}:</span>
                      <span className="ml-1 font-mono">{truncate(flag.value, 40)}</span>
                    </>
                  )}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <CopyableField label="workdir" value={entry.workdir} />

        <div className="flex items-center gap-2">
          <span className="font-medium text-muted-foreground">time:</span>
          <span className="font-mono">{formatTime(entry.created_at)}</span>
        </div>

        {/* Stdin — structured hook data or raw */}
        {entry.stdin && (
          hookData ? (
            <HookDataView hookData={hookData} rawStdin={entry.stdin} />
          ) : (
            <CollapsibleOutput label="stdin" value={entry.stdin} />
          )
        )}

        {entry.stdout && <CollapsibleOutput label="stdout" value={entry.stdout} />}
        {entry.stderr && <CollapsibleOutput label="stderr" value={entry.stderr} />}

        <Button
          variant="outline"
          size="sm"
          className="mt-1 w-fit"
          onClick={() => void onReplay(entry)}
        >
          <Play className="mr-1 h-3 w-3" />
          Re-invoke
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HookDataView — structured display of parsed JSON stdin (hook data)
// ---------------------------------------------------------------------------

function HookDataView({ hookData, rawStdin }: { hookData: HookEventData; rawStdin: string }) {
  const [showRaw, setShowRaw] = useState(false);

  const eventColor = hookData.hook_event_name
    ? EVENT_TYPE_COLORS[hookData.hook_event_name] || ''
    : '';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground">hook data:</span>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          {showRaw ? 'structured' : 'raw'}
        </button>
        <CopyButton value={rawStdin} />
      </div>

      {showRaw ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{rawStdin}</pre>
      ) : (
        <div className="ml-3 flex flex-col gap-1.5">
          {/* Event + tool badges */}
          <div className="flex flex-wrap items-center gap-1">
            {hookData.hook_event_name && (
              <Badge variant="outline" className={`${CHIP} ${eventColor}`}>
                {hookData.hook_event_name}
              </Badge>
            )}
            {hookData.tool_name && (
              <Badge variant="outline" className={CHIP}>
                {hookData.tool_name}
              </Badge>
            )}
            {hookData.permission_mode && (
              <Badge variant="outline" className={`${CHIP} opacity-60`}>
                {hookData.permission_mode}
              </Badge>
            )}
          </div>

          {hookData.session_id && (
            <CopyableField label="session" value={hookData.session_id} />
          )}
          {hookData.cwd && (
            <CopyableField label="cwd" value={hookData.cwd} />
          )}
          {hookData.transcript_path && (
            <div className="flex items-center gap-2">
              <span className="font-medium text-muted-foreground">transcript:</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help font-mono text-muted-foreground">
                    {shortenPath(hookData.transcript_path)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <span className="font-mono text-xs">{hookData.transcript_path}</span>
                </TooltipContent>
              </Tooltip>
              <CopyButton value={hookData.transcript_path} />
            </div>
          )}

          {hookData.tool_input && Object.keys(hookData.tool_input).length > 0 && (
            <CollapsibleJson label="tool_input" data={hookData.tool_input} />
          )}

          {hookData.tool_response && Object.keys(hookData.tool_response).length > 0 && (
            <CollapsibleJson label="tool_response" data={hookData.tool_response} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleJson — expandable JSON object with key-value badge preview
// ---------------------------------------------------------------------------

function CollapsibleJson({ label, data }: { label: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const jsonStr = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const keys = useMemo(() => Object.keys(data), [data]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-medium">{label}</span>
          <span className="text-[10px]">({keys.length} keys)</span>
        </button>
        <CopyButton value={jsonStr} />
      </div>

      {open ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{jsonStr}</pre>
      ) : (
        <div className="ml-4 flex flex-wrap items-center gap-1">
          {keys.slice(0, 6).map((key) => {
            const val = data[key];
            const display = typeof val === 'string'
              ? truncate(val, 30)
              : typeof val === 'number' || typeof val === 'boolean'
                ? String(val)
                : null;

            if (display === null) {
              return (
                <Badge key={key} variant="outline" className="text-[10px] opacity-60">
                  {key}: {'\u2026'}
                </Badge>
              );
            }
            return (
              <Badge key={key} variant="outline" className="text-[10px]">
                <span className="text-muted-foreground">{key}:</span>
                <span className="ml-1">{display}</span>
              </Badge>
            );
          })}
          {keys.length > 6 && (
            <span className="text-[10px] text-muted-foreground">+{keys.length - 6} more</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleOutput — expandable text output with line count
// ---------------------------------------------------------------------------

function CollapsibleOutput({ label, value }: { label: string; value: string }) {
  const [open, setOpen] = useState(false);
  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '\n') count++;
    }
    return count;
  }, [value]);
  const preview = useMemo(
    () => value.length > 120 ? value.slice(0, 120) + '...' : value,
    [value],
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-medium">{label}</span>
          <span className="text-[10px]">({lineCount} lines)</span>
        </button>
        <CopyButton value={value} />
      </div>
      {open ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{value}</pre>
      ) : (
        <div className="truncate font-mono text-muted-foreground">{preview}</div>
      )}
    </div>
  );
}
