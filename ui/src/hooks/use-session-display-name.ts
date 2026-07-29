import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Display label for a `claude_session` chip, with the raw-UUID case healed.
 *
 * A session is indexed straight off `~/.claude/projects/<encoded>/<id>.jsonl`
 * and takes its name from the transcript's own title — `extract_claude_session`
 * resolves `custom_title or slug or session_id`. Claude Code doesn't write a
 * title until a session has run for a while, so a session shared moments after
 * it starts has none of the three and falls through to the bare id: the chip
 * renders a UUID.
 *
 * The owning AgenticProcess already carries the real label (it's named from the
 * prompt), so resolve it HERE — at render, for the one chip actually on screen.
 * Deliberately NOT done in the indexer: `extract_claude_session` is the per-file
 * extractor that runs for every session on every scan (hundreds of files), and
 * the neighbouring `get_claude_session` carries an explicit "must stay cheap"
 * note for exactly that reason. One lookup per visible chip is free; one lookup
 * per file per sweep is not.
 *
 * The query only runs when the label IS the bare id — a session that already
 * has a title costs nothing.
 *
 * @param sessionId  the session's id, or null for non-session chips (no lookup)
 * @param fallback   the label resolved so far (usually `entity.displayName`)
 */
export function useSessionDisplayName(sessionId: string | null | undefined, fallback: string): string {
  const needsLookup = !!sessionId && fallback === sessionId;
  const query = useMemo(
    () =>
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        name: `sessionOwner:${sessionId ?? 'none'}`,
        query: new QueryFilter({ match: { session_id: sessionId ?? '' } }),
      }),
    [sessionId],
  );
  const { data } = useEntitiesQuery<AgenticProcess>(query, { enabled: needsLookup });
  if (!needsLookup) return fallback;
  const owner = (data ?? []).find((p) => (p.name ?? '').trim());
  return owner?.name?.trim() || fallback;
}
