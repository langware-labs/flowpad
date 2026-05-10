/**
 * Per-kind operation row content — icon + label + chips, no chrome.
 *
 * Both `TranscriptEntryItem` (dense transcript mode) and `ChatEntryItem`
 * (chat bubbles) wrap this in their own row container. Knowing the
 * semantic kind in one place means new kinds plug in by adding a case
 * here, never by editing the consumers.
 *
 * Worker-specific shape sniffing (`input.file_path` vs. `input.cmd`) used
 * to live in the renderer; now the parser already mapped each tool onto a
 * semantic entry, and this component just reads the typed fields.
 */

import {
  Bot,
  FileText,
  Globe,
  ListChecks,
  Pencil,
  Search,
  Terminal,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type {
  AgentSpawnEntry,
  FileEditEntry,
  FileReadEntry,
  FileWriteEntry,
  GenericEntry,
  SearchEntry,
  ShellCommandEntry,
  TodoUpdateEntry,
  ToolUseEntry,
  WebFetchEntry,
} from '@sdk';

interface OperationOneLinerProps {
  operation: GenericEntry;
}

interface KindMeta {
  Icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  label: string;
  primary: string;        // path / command preview / query / etc.
  chips: string[];        // additional chips (line counts, exit code, …)
}

function basename(p: string): string {
  if (!p) return '';
  return p.split('/').pop() || p;
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}

function kindMeta(op: GenericEntry): KindMeta | null {
  switch (op.kind) {
    case 'file_write': {
      const e = op as FileWriteEntry;
      const chips: string[] = [];
      if (e.line_count != null) chips.push(`+${e.line_count} lines`);
      if (e.is_new) chips.push('new');
      return {
        Icon: FileText,
        iconClassName: 'text-emerald-500',
        label: 'Write',
        primary: basename(e.path),
        chips,
      };
    }
    case 'file_edit': {
      const e = op as FileEditEntry;
      const chips: string[] = [];
      if (e.hunks?.length) chips.push(`${e.hunks.length} hunk${e.hunks.length === 1 ? '' : 's'}`);
      return {
        Icon: Pencil,
        iconClassName: 'text-amber-500',
        label: 'Edit',
        primary: basename(e.path),
        chips,
      };
    }
    case 'file_read': {
      const e = op as FileReadEntry;
      const chips: string[] = [];
      if (e.start_line != null && e.end_line != null) chips.push(`${e.start_line}-${e.end_line}`);
      if (e.bytes_count != null) chips.push(`${e.bytes_count}B`);
      return {
        Icon: FileText,
        iconClassName: 'text-sky-500',
        label: 'Read',
        primary: basename(e.path),
        chips,
      };
    }
    case 'shell_command': {
      const e = op as ShellCommandEntry;
      const chips: string[] = [];
      if (e.exit_code != null && e.exit_code !== 0) chips.push(`exit ${e.exit_code}`);
      if (e.duration_ms != null && e.duration_ms > 0) chips.push(`${(e.duration_ms / 1000).toFixed(1)}s`);
      return {
        Icon: Terminal,
        iconClassName: e.exit_code != null && e.exit_code !== 0 ? 'text-red-500' : 'text-orange-500',
        label: 'Shell',
        primary: firstLine(e.command),
        chips,
      };
    }
    case 'search': {
      const e = op as SearchEntry;
      const chips: string[] = [];
      if (e.match_count != null) chips.push(`${e.match_count} matches`);
      if (e.path) chips.push(basename(e.path));
      return {
        Icon: Search,
        iconClassName: 'text-purple-500',
        label: e.search_kind || 'Search',
        primary: e.query,
        chips,
      };
    }
    case 'web_fetch': {
      const e = op as WebFetchEntry;
      let host = '';
      if (e.url) {
        try { host = new URL(e.url).host; } catch { host = e.url; }
      }
      return {
        Icon: Globe,
        iconClassName: 'text-blue-500',
        label: 'Web',
        primary: host || (e.query ?? ''),
        chips: e.status_code != null ? [`status ${e.status_code}`] : [],
      };
    }
    case 'todo_update': {
      const e = op as TodoUpdateEntry;
      return {
        Icon: ListChecks,
        iconClassName: 'text-cyan-500',
        label: 'Todos',
        primary: `${e.items.length} item${e.items.length === 1 ? '' : 's'}`,
        chips: [],
      };
    }
    case 'agent_spawn': {
      const e = op as AgentSpawnEntry;
      return {
        Icon: Bot,
        iconClassName: 'text-fuchsia-500',
        label: e.agent_type || 'Agent',
        primary: e.description || firstLine(e.prompt ?? ''),
        chips: [],
      };
    }
    case 'tool_use': {
      const e = op as ToolUseEntry;
      // Catch-all bucket — render the raw tool name so MCP / unknown
      // tools still show up identifiably.
      return {
        Icon: Terminal,
        iconClassName: 'text-orange-400',
        label: e.tool_name || 'tool',
        primary: '',
        chips: [],
      };
    }
    default:
      return null;
  }
}

/** Inline one-liner: `<icon> <label> · <primary>` + chips. */
export function OperationOneLiner({ operation }: OperationOneLinerProps) {
  const meta = kindMeta(operation);
  if (!meta) return null;
  const { Icon, iconClassName, label, primary, chips } = meta;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} />
      <span className="shrink-0 font-mono text-[11px] font-medium text-foreground/80">{label}</span>
      {primary && (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{primary}</span>
      )}
      {chips.map((c, i) => (
        <span key={i} className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
          {c}
        </span>
      ))}
    </div>
  );
}

/**
 * Expandable detail panel for an operation — shows the file content,
 * shell stdout, search results, etc. Returns null when the kind has no
 * worth-displaying detail.
 */
export function OperationExpandedDetail({ operation }: OperationOneLinerProps) {
  switch (operation.kind) {
    case 'file_write': {
      const e = operation as FileWriteEntry;
      if (!e.content) return null;
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {e.content}
        </pre>
      );
    }
    case 'file_edit': {
      const e = operation as FileEditEntry;
      if (!e.hunks?.length && !e.change_summary) return null;
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {e.change_summary ?? JSON.stringify(e.hunks, null, 2)}
        </pre>
      );
    }
    case 'file_read': {
      const e = operation as FileReadEntry;
      if (!e.content_preview) return null;
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {e.content_preview}
        </pre>
      );
    }
    case 'shell_command': {
      const e = operation as ShellCommandEntry;
      const cmd = e.command ?? '';
      const out = e.stdout_preview ?? '';
      const err = e.stderr_preview ?? '';
      return (
        <div className="space-y-1">
          <pre className="overflow-auto whitespace-pre-wrap font-mono text-[10px] text-foreground/80">$ {cmd}</pre>
          {out && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{out}</pre>
          )}
          {err && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-red-500">{err}</pre>
          )}
        </div>
      );
    }
    case 'search': {
      const e = operation as SearchEntry;
      if (!e.results_preview) return null;
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {e.results_preview}
        </pre>
      );
    }
    case 'web_fetch': {
      const e = operation as WebFetchEntry;
      if (!e.result_preview && !e.prompt) return null;
      return (
        <div className="space-y-1">
          {e.prompt && (
            <pre className="whitespace-pre-wrap font-mono text-[10px] text-foreground/70">{e.prompt}</pre>
          )}
          {e.result_preview && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
              {e.result_preview}
            </pre>
          )}
        </div>
      );
    }
    case 'todo_update': {
      const e = operation as TodoUpdateEntry;
      if (!e.items.length) return null;
      return (
        <ul className="space-y-0.5 text-[11px]">
          {e.items.map((it, i) => {
            const status = (it as { status?: string }).status ?? '';
            const content = (it as { content?: string; activeForm?: string }).content
              ?? (it as { activeForm?: string }).activeForm ?? '';
            return (
              <li key={i} className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">[{status}]</span>
                <span className="text-foreground/80">{content}</span>
              </li>
            );
          })}
        </ul>
      );
    }
    case 'agent_spawn': {
      const e = operation as AgentSpawnEntry;
      if (!e.prompt) return null;
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {e.prompt}
        </pre>
      );
    }
    case 'tool_use': {
      const e = operation as ToolUseEntry;
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {JSON.stringify(e.tool_input, null, 2)}
        </pre>
      );
    }
    default:
      return null;
  }
}
