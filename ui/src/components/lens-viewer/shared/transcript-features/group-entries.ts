import type {
  AgentSpawnEntry,
  FileEditEntry,
  FileReadEntry,
  FileWriteEntry,
  GenericEntry,
  SearchEntry,
  ShellCommandEntry,
  SkillCallEntry,
  TodoUpdateEntry,
  WebFetchEntry,
} from '@sdk';
import { isOperation, isToolUse } from '@sdk';

import type { UnifiedEntry, UnifiedRole } from './types';

/** Strip the `:usage` or `:usage:dim_N` suffix the python parser appends to UsageEntry ids. */
function baseId(id: string): string {
  return id.replace(/:usage(?::dim_\d+)?$/, '');
}

/** Aggregate adjacent `token_usage` entries (per-dim or legacy aggregate)
 *  into one `TokenUsage` view-model. Cost is priced by the backend and
 *  carried on each entry as `cost_usd`. */
function aggregateUsage(usageEntries: ReadonlyArray<GenericEntry & { kind: 'token_usage' }>): import('./types').TokenUsage | null {
  if (usageEntries.length === 0) return null;
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, reasoning = 0;
  let costUsd = 0;
  const model = (usageEntries[0] as { model?: string | null }).model ?? null;
  const isPerDim = (u: typeof usageEntries[number]) => typeof u.io === 'string' && typeof u.count === 'number';
  for (const u of usageEntries) {
    if (isPerDim(u)) {
      const count = u.count ?? 0;
      if (u.io === 'output') {
        if (u.reasoning) reasoning += count;
        else output += count;
      } else if (u.cache === 'read') {
        cacheRead += count;
      } else if (u.cache === 'write') {
        cacheCreation += count;
      } else {
        input += count;
      }
      costUsd += u.cost_usd ?? 0;
    } else {
      // Legacy aggregate shape. Token counts still aggregate; cost comes from
      // the backend like every other entry (0 when it priced nothing).
      const ui = u.input_tokens ?? 0;
      const uo = u.output_tokens ?? 0;
      const ur = u.cache_read_tokens ?? u.cached_input_tokens ?? 0;
      const uw = u.cache_creation_tokens ?? 0;
      const ureasoning = u.reasoning_output_tokens ?? 0;
      input += ui;
      output += uo;
      cacheRead += ur;
      cacheCreation += uw;
      reasoning += ureasoning;
      costUsd += u.cost_usd ?? 0;
    }
  }
  return {
    input,
    output,
    cached: cacheRead || null,
    cacheRead: cacheRead || null,
    cacheCreation: cacheCreation || null,
    reasoning: reasoning || null,
    costUsd: costUsd > 0 ? costUsd : null,
    model,
  };
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
  // Dedup streaming snapshots: Claude Code writes each turn multiple times
  // (partial → final) sharing one `message.id`, which the python parser
  // surfaces as `entry_id`. Only the first occurrence is billable (the
  // python side dedups USAGE on those); the duplicates have no adjacent
  // token_usage and would otherwise render as cost-less ghost rows.
  const seenMessageIds = new Set<string>();
  // For codex transcripts: trailing token_usage entries (turn summary
  // emitted as a separate response_item) get attached back to the most
  // recent assistant/operation row in `out`. The map keys by that row's
  // id so we can accumulate multiple per-dim entries and re-aggregate.
  const trailingUsage = new Map<string, Array<GenericEntry & { kind: 'token_usage' }>>();
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    const ebid = baseId(e.id);

    // Skip duplicate snapshots of an already-rendered message.
    const eid = (e as { entry_id?: string | null }).entry_id;
    if (
      eid &&
      (e.kind === 'assistant_message' || isOperation(e)) &&
      seenMessageIds.has(eid)
    ) {
      i++;
      continue;
    }

    // Operation rows: their own row, but ALSO pick up adjacent token_usage
    // (same base id) — Python attaches usage to whichever entry the line
    // produced, including semantic operations (tool_use, shell_command,
    // file_read, …). Without this, tool-heavy sessions render every
    // tool-call row with no cost.
    if (isOperation(e)) {
      if (eid) seenMessageIds.add(eid);
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

    if (e.kind === 'assistant_message') {
      if (eid) seenMessageIds.add(eid);
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
    // Standalone token_usage. Two shapes:
    //   • Claude: usage entries land adjacent to their assistant/operation
    //     line and are picked up by the in-loop sub-walk above. None should
    //     fall through here.
    //   • Codex: usage is emitted as a *turn summary* on its own response_item
    //     line, with a base id that doesn't match any earlier message line.
    //     Attach it to the most recent assistant/operation in `out` so a
    //     codex turn's cost lands on the row the user actually sees.
    if (e.kind === 'token_usage') {
      for (let k = out.length - 1; k >= 0; k--) {
        const anchor = out[k];
        if (anchor.role !== 'assistant' && anchor.role !== 'operation') continue;
        const buf = trailingUsage.get(anchor.id) ?? [];
        buf.push(e as GenericEntry & { kind: 'token_usage' });
        trailingUsage.set(anchor.id, buf);
        const merged = aggregateUsage(buf);
        if (merged) anchor.usage = merged;
        break;
      }
      i++;
      continue;
    }
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

  // Collect any adjacent token_usage entries up-front so both operation and
  // assistant_message branches can share the aggregator.
  const usageEntries = group.filter((g): g is GenericEntry & { kind: 'token_usage' } => g.kind === 'token_usage');
  const aggregatedUsage = aggregateUsage(usageEntries);

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
    if (aggregatedUsage) out.usage = aggregatedUsage;
    out.searchHaystack = operationHaystack(anchor);
    return out;
  }

  // Assistant text turn (+ optional adjacent token_usage)
  const am = group.find((g) => g.kind === 'assistant_message');
  if (am) {
    const out: UnifiedEntry = { ...base, role: 'assistant', kind: 'assistant_message', searchHaystack: '' };
    if (am.kind === 'assistant_message') {
      if (am.text) out.text = am.text;
      if (am.thinking) out.thinking = am.thinking;
    }
    if (aggregatedUsage) out.usage = aggregatedUsage;
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
    case 'skill_call': {
      const e = op as SkillCallEntry;
      return `skill ${e.skill_name} ${e.invocation_kind} ${e.tool_name}`.toLowerCase();
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
