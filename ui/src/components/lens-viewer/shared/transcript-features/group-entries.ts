import type {
  AgentSpawnEntry,
  FileEditEntry,
  FileReadEntry,
  FileWriteEntry,
  GenericEntry,
  SearchEntry,
  ShellCommandEntry,
  TodoUpdateEntry,
  WebFetchEntry,
} from '@sdk';
import { isOperation, isToolUse } from '@sdk';

import type { UnifiedEntry, UnifiedRole } from './types';

/** Strip the `:usage` suffix the python parser appends to TokenUsageEntry ids. */
function baseId(id: string): string {
  return id.endsWith(':usage') ? id.slice(0, -':usage'.length) : id;
}

/**
 * Project `GenericEntry[]` onto `UnifiedEntry[]` (one row per logical turn).
 *
 * Grouping rule:
 *   - Assistant text turns collapse with their adjacent `token_usage` row
 *     (the python parser emits the token_usage row with id `<base>:usage`).
 *   - Each semantic **operation** kind (file_write / shell_command / …) and
 *     the catch-all `tool_use` are independent rows — never merged with the
 *     surrounding assistant message.
 *   - User rows pair with adjacent same-id `tool_result` rows when present
 *     (catch-all path; semantic results are already folded server-side).
 *   - Everything else is one row per source entry.
 *
 * Preserves source order. The shape is deliberately flat: the renderer
 * reads `e.text`, `e.operation`, `e.toolUse`, etc. directly.
 */
export function groupEntriesByTurn(entries: GenericEntry[]): UnifiedEntry[] {
  const out: UnifiedEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    const ebid = baseId(e.id);

    // Operation rows are always their own row — no merge with neighbours.
    if (isOperation(e)) {
      const projected = projectGroup([e]);
      if (projected) out.push(projected);
      i++;
      continue;
    }

    if (e.kind === 'assistant_message') {
      const group: GenericEntry[] = [e];
      let j = i + 1;
      while (j < entries.length && baseId(entries[j].id) === ebid &&
             entries[j].kind === 'token_usage') {
        group.push(entries[j]);
        j++;
      }
      const projected = projectGroup(group);
      if (projected) out.push(projected);
      i = j;
      continue;
    }
    if (e.kind === 'user_message' || e.kind === 'tool_result') {
      const group: GenericEntry[] = [e];
      let j = i + 1;
      while (j < entries.length && baseId(entries[j].id) === ebid &&
             (entries[j].kind === 'tool_result' || entries[j].kind === 'user_message')) {
        group.push(entries[j]);
        j++;
      }
      const projected = projectGroup(group);
      if (projected) out.push(projected);
      i = j;
      continue;
    }
    // Standalone token_usage (no immediate assistant anchor) → drop.
    if (e.kind === 'token_usage') { i++; continue; }
    // Everything else (system, meta, summary, unknown): one row each.
    const projected = projectGroup([e]);
    if (projected) out.push(projected);
    i++;
  }
  return out;
}

function projectGroup(group: GenericEntry[]): UnifiedEntry | null {
  const anchor = group[0];
  const base = {
    id: baseId(anchor.id),
    timestamp: anchor.timestamp,
    sessionId: anchor.session_id,
    parentId: anchor.parent_id ?? null,
    isSidechain: anchor.is_sidechain ?? false,
    worker: anchor.worker,
    rawEntries: group,
  };

  if (isOperation(anchor)) {
    const out: UnifiedEntry = {
      ...base,
      role: 'operation',
      kind: anchor.kind,
      operation: anchor,
      searchHaystack: '',
    };
    if (isToolUse(anchor)) {
      out.toolUse = {
        name: anchor.tool_name,
        toolUseId: anchor.tool_use_id,
        input: anchor.tool_input,
      };
    }
    out.searchHaystack = operationHaystack(anchor);
    return out;
  }

  // Assistant text turn (+ optional adjacent token_usage)
  const am = group.find((g) => g.kind === 'assistant_message');
  const usage = group.find((g) => g.kind === 'token_usage');
  if (am) {
    const out: UnifiedEntry = { ...base, role: 'assistant', kind: 'assistant_message', searchHaystack: '' };
    if (am.kind === 'assistant_message') {
      if (am.text) out.text = am.text;
      if (am.thinking) out.thinking = am.thinking;
    }
    if (usage && usage.kind === 'token_usage') {
      out.usage = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cached: usage.cached_input_tokens,
        cacheRead: usage.cache_read_tokens,
        cacheCreation: usage.cache_creation_tokens,
        reasoning: usage.reasoning_output_tokens,
      };
    }
    out.searchHaystack = ((out.text ?? '') + ' ' + (out.thinking ?? '')).toLowerCase();
    return out;
  }

  // User turn — text or tool_result (catch-all paired result)
  const um = group.find((g) => g.kind === 'user_message');
  const tr = group.find((g) => g.kind === 'tool_result');
  if (um || tr) {
    const out: UnifiedEntry = { ...base, role: 'user', kind: um ? 'user_message' : 'tool_result', searchHaystack: '' };
    if (um && um.kind === 'user_message' && um.text) out.text = um.text;
    if (tr && tr.kind === 'tool_result') {
      out.toolResult = {
        toolUseId: tr.tool_use_id,
        output: tr.tool_output,
        isError: tr.is_error ?? false,
        filePath: tr.file_path,
        durationMs: tr.duration_ms,
        exitCode: tr.exit_code,
      };
    }
    out.searchHaystack = ((out.text ?? '') + ' ' + (out.toolResult?.output ?? '')).toLowerCase();
    return out;
  }

  // System / progress / hooks
  if (anchor.kind === 'system') {
    return {
      ...base, role: 'system', kind: 'system', subtype: anchor.subtype, payload: anchor.payload,
      searchHaystack: ((anchor.subtype ?? '') + ' ' + payloadToHaystack(anchor.payload)).toLowerCase(),
    };
  }
  if (anchor.kind === 'summary') {
    return {
      ...base, role: 'summary', kind: 'summary', summary: anchor.summary_text,
      searchHaystack: (anchor.summary_text ?? '').toLowerCase(),
    };
  }
  if (anchor.kind === 'meta') {
    return {
      ...base, role: 'meta', kind: 'meta', subtype: anchor.meta_kind, payload: anchor.payload,
      searchHaystack: ((anchor.meta_kind ?? '') + ' ' + payloadToHaystack(anchor.payload)).toLowerCase(),
    };
  }
  if (anchor.kind === 'unknown') {
    return {
      ...base, role: 'unknown', kind: 'unknown', payload: anchor.raw_data,
      searchHaystack: payloadToHaystack(anchor.raw_data).toLowerCase(),
    };
  }
  return null;
}

/**
 * Search-haystack for an operation row. Picks the fields a user is likely to
 * grep for (path, command, query, url, prompt, …) instead of stringifying
 * the entire entry — keeps the search filter O(N) string compares per
 * keystroke instead of O(N · entry-size) JSON serializations.
 */
function operationHaystack(op: GenericEntry): string {
  switch (op.kind) {
    case 'file_write':
    case 'file_edit':
    case 'file_read': {
      const e = op as FileWriteEntry | FileEditEntry | FileReadEntry;
      return `${op.kind} ${e.path}`.toLowerCase();
    }
    case 'shell_command': {
      const e = op as ShellCommandEntry;
      return `shell ${e.command} ${e.cwd ?? ''}`.toLowerCase();
    }
    case 'search': {
      const e = op as SearchEntry;
      return `${e.search_kind} ${e.query} ${e.path ?? ''}`.toLowerCase();
    }
    case 'web_fetch': {
      const e = op as WebFetchEntry;
      return `web ${e.url ?? ''} ${e.query ?? ''} ${e.prompt ?? ''}`.toLowerCase();
    }
    case 'todo_update': {
      const e = op as TodoUpdateEntry;
      return `todos ${e.items.length}`.toLowerCase();
    }
    case 'agent_spawn': {
      const e = op as AgentSpawnEntry;
      return `agent ${e.agent_type} ${e.description ?? ''} ${e.prompt ?? ''}`.toLowerCase();
    }
    case 'tool_use':
      return `${op.tool_name} ${stableStringify(op.tool_input)}`.toLowerCase();
    default:
      return '';
  }
}

/** Bounded string projection of a payload — avoids unbounded JSON.stringify. */
function payloadToHaystack(payload: unknown): string {
  if (!payload) return '';
  try { return stableStringify(payload).slice(0, 4000); } catch { return ''; }
}

function stableStringify(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/** Convenience role test for filters. */
export function roleIs(entry: UnifiedEntry, ...roles: UnifiedRole[]): boolean {
  return roles.includes(entry.role);
}
