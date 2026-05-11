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

import type { GenericEntry } from '@sdk';

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
      const chips: string[] = [];
      if (op.line_count != null) chips.push(`+${op.line_count} lines`);
      if (op.is_new) chips.push('new');
      return { Icon: FileText, iconClassName: 'text-emerald-500', label: 'Write', primary: basename(op.path), chips };
    }
    case 'file_edit': {
      const chips: string[] = [];
      if (op.hunks?.length) chips.push(`${op.hunks.length} hunk${op.hunks.length === 1 ? '' : 's'}`);
      return { Icon: Pencil, iconClassName: 'text-amber-500', label: 'Edit', primary: basename(op.path), chips };
    }
    case 'file_read': {
      const chips: string[] = [];
      if (op.start_line != null && op.end_line != null) chips.push(`${op.start_line}-${op.end_line}`);
      if (op.bytes_count != null) chips.push(`${op.bytes_count}B`);
      return { Icon: FileText, iconClassName: 'text-sky-500', label: 'Read', primary: basename(op.path), chips };
    }
    case 'shell_command': {
      const failed = op.exit_code != null && op.exit_code !== 0;
      const chips: string[] = [];
      if (failed) chips.push(`exit ${op.exit_code}`);
      if (op.duration_ms != null && op.duration_ms > 0) chips.push(`${(op.duration_ms / 1000).toFixed(1)}s`);
      return {
        Icon: Terminal,
        iconClassName: failed ? 'text-red-500' : 'text-orange-500',
        label: 'Shell',
        primary: firstLine(op.command),
        chips,
      };
    }
    case 'search': {
      const chips: string[] = [];
      if (op.match_count != null) chips.push(`${op.match_count} matches`);
      if (op.path) chips.push(basename(op.path));
      return { Icon: Search, iconClassName: 'text-purple-500', label: op.search_kind || 'Search', primary: op.query, chips };
    }
    case 'web_fetch': {
      let host = '';
      if (op.url) {
        try { host = new URL(op.url).host; } catch { host = op.url; }
      }
      return {
        Icon: Globe,
        iconClassName: 'text-blue-500',
        label: 'Web',
        primary: host || (op.query ?? ''),
        chips: op.status_code != null ? [`status ${op.status_code}`] : [],
      };
    }
    case 'todo_update':
      return {
        Icon: ListChecks,
        iconClassName: 'text-cyan-500',
        label: 'Todos',
        primary: `${op.items.length} item${op.items.length === 1 ? '' : 's'}`,
        chips: [],
      };
    case 'agent_spawn':
      return {
        Icon: Bot,
        iconClassName: 'text-fuchsia-500',
        label: op.agent_type || 'Agent',
        primary: op.description || firstLine(op.prompt ?? ''),
        chips: [],
      };
    case 'tool_use':
      return { Icon: Terminal, iconClassName: 'text-orange-400', label: op.tool_name || 'tool', primary: '', chips: [] };
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
    case 'file_write':
      if (!operation.content) return null;
      return <PreBlock>{operation.content}</PreBlock>;
    case 'file_edit':
      if (!operation.hunks?.length && !operation.change_summary) return null;
      return <PreBlock>{operation.change_summary ?? JSON.stringify(operation.hunks, null, 2)}</PreBlock>;
    case 'file_read':
      if (!operation.content_preview) return null;
      return <PreBlock>{operation.content_preview}</PreBlock>;
    case 'shell_command': {
      const out = operation.stdout_preview ?? '';
      const err = operation.stderr_preview ?? '';
      return (
        <div className="space-y-1">
          <pre className="overflow-auto whitespace-pre-wrap font-mono text-[10px] text-foreground/80">$ {operation.command ?? ''}</pre>
          {out && <PreBlock>{out}</PreBlock>}
          {err && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-red-500">{err}</pre>}
        </div>
      );
    }
    case 'search':
      if (!operation.results_preview) return null;
      return <PreBlock>{operation.results_preview}</PreBlock>;
    case 'web_fetch':
      if (!operation.result_preview && !operation.prompt) return null;
      return (
        <div className="space-y-1">
          {operation.prompt && <pre className="whitespace-pre-wrap font-mono text-[10px] text-foreground/70">{operation.prompt}</pre>}
          {operation.result_preview && <PreBlock>{operation.result_preview}</PreBlock>}
        </div>
      );
    case 'todo_update':
      if (!operation.items.length) return null;
      return (
        <ul className="space-y-0.5 text-[11px]">
          {operation.items.map((it, i) => {
            const item = it as { status?: string; content?: string; activeForm?: string };
            return (
              <li key={i} className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">[{item.status ?? ''}]</span>
                <span className="text-foreground/80">{item.content ?? item.activeForm ?? ''}</span>
              </li>
            );
          })}
        </ul>
      );
    case 'agent_spawn':
      if (!operation.prompt) return null;
      return <PreBlock>{operation.prompt}</PreBlock>;
    case 'tool_use':
      return <PreBlock>{JSON.stringify(operation.tool_input, null, 2)}</PreBlock>;
    default:
      return null;
  }
}

function PreBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
      {children}
    </pre>
  );
}
