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

import { ArrowUpRight, Bot, FileText, Globe, ListChecks, Pencil, Search, Sparkles, Terminal } from 'lucide-react';
import type { ComponentType } from 'react';

import { Trans, useLingui } from '@lingui/react/macro';
import type { GenericEntry } from '@sdk';

import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import type { TokenUsage } from './types';

interface OperationOneLinerProps {
  operation: GenericEntry;
  /** Aggregated per-turn token usage. When present and `costUsd > 0`,
   *  renders a $X.XXX pill in the one-liner header so tool-call rows
   *  show their cost the same way assistant text rows do. */
  usage?: TokenUsage | null;
}

function formatCost(usd?: number | null): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

interface KindMeta {
  Icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  label: string;
  primary: string; // path / command preview / query / etc.
  chips: string[]; // additional chips (line counts, exit code, …)
}

function basename(p: string): string {
  if (!p) return '';
  return p.split('/').pop() || p;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  );
}

function kindMeta(op: GenericEntry, t: any): KindMeta | null {
  switch (op.kind) {
    case 'file_write': {
      const chips: string[] = [];
      if (op.line_count != null) chips.push(`+${op.line_count} lines`);
      if (op.is_new) chips.push(t`new`);
      return { Icon: FileText, iconClassName: 'text-emerald-500', label: t`Write`, primary: basename(op.path), chips };
    }
    case 'file_edit': {
      const chips: string[] = [];
      if (op.hunks?.length) chips.push(`${op.hunks.length} hunk${op.hunks.length === 1 ? '' : 's'}`);
      return { Icon: Pencil, iconClassName: 'text-amber-500', label: t`Edit`, primary: basename(op.path), chips };
    }
    case 'file_read': {
      const chips: string[] = [];
      if (op.start_line != null && op.end_line != null) chips.push(`${op.start_line}-${op.end_line}`);
      if (op.bytes_count != null) chips.push(`${op.bytes_count}B`);
      return { Icon: FileText, iconClassName: 'text-sky-500', label: t`Read`, primary: basename(op.path), chips };
    }
    case 'shell_command': {
      const failed = op.exit_code != null && op.exit_code !== 0;
      const chips: string[] = [];
      if (failed) chips.push(`exit ${op.exit_code}`);
      if (op.duration_ms != null && op.duration_ms > 0) chips.push(`${(op.duration_ms / 1000).toFixed(1)}s`);
      return {
        Icon: Terminal,
        iconClassName: failed ? 'text-red-500' : 'text-orange-500',
        label: t`Shell`,
        primary: firstLine(op.command),
        chips,
      };
    }
    case 'search': {
      const chips: string[] = [];
      if (op.match_count != null) chips.push(`${op.match_count} matches`);
      if (op.path) chips.push(basename(op.path));
      return {
        Icon: Search,
        iconClassName: 'text-purple-500',
        label: op.search_kind || t`Search`,
        primary: op.query,
        chips,
      };
    }
    case 'web_fetch': {
      let host = '';
      if (op.url) {
        try {
          host = new URL(op.url).host;
        } catch {
          host = op.url;
        }
      }
      return {
        Icon: Globe,
        iconClassName: 'text-blue-500',
        label: t`Web`,
        primary: host || (op.query ?? ''),
        chips: op.status_code != null ? [`status ${op.status_code}`] : [],
      };
    }
    case 'todo_update':
      return {
        Icon: ListChecks,
        iconClassName: 'text-cyan-500',
        label: t`Todos`,
        primary: `${op.items.length} item${op.items.length === 1 ? '' : 's'}`,
        chips: [],
      };
    case 'agent_spawn':
      return {
        Icon: Bot,
        iconClassName: 'text-fuchsia-500',
        label: op.agent_type || t`SubAgent`,
        primary: op.description || firstLine(op.prompt ?? ''),
        chips: [],
      };
    case 'skill_call':
      return {
        Icon: Sparkles,
        iconClassName: 'text-purple-500',
        label: t`Skill`,
        primary: op.skill_name,
        chips: op.invocation_kind ? [op.invocation_kind.replace(/_/g, ' ')] : [],
      };
    case 'tool_use':
      return {
        Icon: Terminal,
        iconClassName: 'text-orange-400',
        label: op.tool_name || t`tool`,
        primary: '',
        chips: [],
      };
    default:
      return null;
  }
}

/** Inline one-liner: `<icon> <label> · <primary>` + chips. */
export function OperationOneLiner({ operation, usage }: OperationOneLinerProps) {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const meta = kindMeta(operation, t);
  if (!meta) return null;
  const { Icon, iconClassName, label, primary, chips } = meta;
  const costLabel = formatCost(usage?.costUsd);
  // Workflow spawns carry the path to the spawned agent's own transcript — let
  // the user drill into it (opened as a claude transcript by absolute path).
  const childPath = operation.kind === 'agent_spawn' ? (operation.child_transcript_path ?? null) : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} />
      <span className="shrink-0 font-mono text-[11px] font-medium text-foreground/80">{label}</span>
      {primary && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{primary}</span>}
      {chips.map((c, i) => (
        <span key={i} className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
          {c}
        </span>
      ))}
      {costLabel && (
        <span
          className="shrink-0 text-[10px] font-medium tabular-nums text-foreground/80"
          data-testid="turn-cost-usd"
          title={`${usage?.model ?? 'unknown model'} · cost for this turn`}
        >
          {costLabel}
        </span>
      )}
      {childPath && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // forLensTranscript leaves claude refs un-encoded, so pre-encode the
            // absolute path into ONE pointer segment (no literal slashes). The
            // dock URL pipeline then encodes it again; browser + LensViewer
            // decode twice back to the absolute path. Mirrors codex/copilot.
            navigation.openDockPointer(DockPointer.forLensTranscript('claude', encodeURIComponent(childPath)));
          }}
          className="ms-auto inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t`Open this agent's transcript`}
          data-testid="open-subagent-transcript"
        >
          <ArrowUpRight className="h-3 w-3" />
          <Trans>Open</Trans>
        </button>
      )}
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
          <pre className="overflow-auto whitespace-pre-wrap font-mono text-[10px] text-foreground/80">
            $ {operation.command ?? ''}
          </pre>
          {out && <PreBlock>{out}</PreBlock>}
          {err && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-red-500">{err}</pre>
          )}
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
          {operation.prompt && (
            <pre className="whitespace-pre-wrap font-mono text-[10px] text-foreground/70">{operation.prompt}</pre>
          )}
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
