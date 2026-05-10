import type { GenericEntry } from '@sdk';
import type { UnifiedEntry, UnifiedRole } from './types';

/** Strip the `:usage` suffix the python parser appends to TokenUsageEntry ids. */
function baseId(id: string): string {
  return id.endsWith(':usage') ? id.slice(0, -':usage'.length) : id;
}

/**
 * Project `GenericEntry[]` onto `UnifiedEntry[]` (one row per logical turn).
 *
 * Grouping rule: ONLY assistant-turn parts collapse — `assistant_message`
 * + `tool_use` + `token_usage` rows that share the same base id (the python
 * parser emits the token_usage row with id `<base>:usage`). Same-kind groups
 * for `user` (a `user_message` paired with a `tool_result` from the same line)
 * also collapse. Everything else is one row per source entry — even if two
 * meta lines share an id from the parser's `sessionId` fallback (queue-op,
 * ai-title, last-prompt, attachment do this and would otherwise collide).
 *
 * Preserves source order. The shape is deliberately flat (no nested
 * `message.content[]`): the renderer reads `e.text`, `e.thinking`,
 * `e.toolUse`, etc. directly — no Claude-specific adapter.
 */
export function groupEntriesByTurn(entries: GenericEntry[]): UnifiedEntry[] {
  const out: UnifiedEntry[] = [];
  // Lookahead group: walk entries linearly; when we see an assistant turn
  // anchor, eagerly collect its companion `token_usage` row that shares the
  // same base id (the python parser always emits them adjacent). Same for a
  // user row that's followed by its tool_result counterpart on the same id.
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    const ebid = baseId(e.id);

    if (e.kind === 'assistant_message' || e.kind === 'tool_use' || e.kind === 'exit_plan_mode' as unknown) {
      const group: GenericEntry[] = [e];
      // pull in any same-base-id companions immediately following
      let j = i + 1;
      while (j < entries.length && baseId(entries[j].id) === ebid &&
             (entries[j].kind === 'token_usage' || entries[j].kind === 'tool_use' || entries[j].kind === 'assistant_message')) {
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
    // Everything else (system, meta, summary, unknown): one row each, no
    // grouping. This is what fixes the queue-operation/ai-title collision.
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
    rawEntries: group,
  };

  // Assistant turn — text and/or tool_use, plus optional token_usage
  const am = group.find((g) => g.kind === 'assistant_message');
  const tu = group.find((g) => g.kind === 'tool_use');
  const usage = group.find((g) => g.kind === 'token_usage');
  if (am || tu) {
    const out: UnifiedEntry = { ...base, role: 'assistant' };
    if (am && am.kind === 'assistant_message') {
      if (am.text) out.text = am.text;
      if (am.thinking) out.thinking = am.thinking;
    }
    if (tu && tu.kind === 'tool_use') {
      out.toolUse = { name: tu.tool_name, toolUseId: tu.tool_use_id, input: tu.tool_input };
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
    return out;
  }

  // User turn — text or tool_result
  const um = group.find((g) => g.kind === 'user_message');
  const tr = group.find((g) => g.kind === 'tool_result');
  if (um || tr) {
    const out: UnifiedEntry = { ...base, role: 'user' };
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
    return out;
  }

  // System / progress / hooks
  if (anchor.kind === 'system') {
    return { ...base, role: 'system', subtype: anchor.subtype, payload: anchor.payload };
  }
  // Summary
  if (anchor.kind === 'summary') {
    return { ...base, role: 'summary', summary: anchor.summary_text };
  }
  // Meta lines (file-history-snapshot, queue-operation, ai-title, attachment, …)
  if (anchor.kind === 'meta') {
    return { ...base, role: 'meta', subtype: anchor.meta_kind, payload: anchor.payload };
  }
  // Unknown
  if (anchor.kind === 'unknown') {
    return { ...base, role: 'unknown', payload: anchor.raw_data };
  }
  // Standalone token_usage with no parent assistant — drop (renders nowhere).
  return null;
}

/** Convenience role test for filters. */
export function roleIs(entry: UnifiedEntry, ...roles: UnifiedRole[]): boolean {
  return roles.includes(entry.role);
}
