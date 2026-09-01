import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { toDriverKey } from '@src/components/assets/editor/agent-profile/agent-vocabularies';

const QUERY_KEY = ['agent-resources', 'mcp-servers'] as const;

/** Module-scope: `useEntityOps` keys its effect on the array's IDENTITY. */
const WATCHED_TYPES = ['capability'];

interface CapabilityRow {
  id?: string;
  kind?: string;
  name?: string;
}

export interface McpServerRow {
  /** Capability kind — unique per (service, worker), so it keys the row. */
  id: string;
  name: string;
  /** The worker this server is configured for (`claude_code`, `codex`, …). */
  workerType: string;
}

/**
 * MCP servers available to a worker. Read from CAPABILITY rows, whose kind is
 * `<service>.mcp.<worker_type>` — the only source carrying a worker dimension.
 * `include_system=true` is required: every capability row is system-scoped.
 */
export function useWirableMcpServers(workerType: string): { servers: McpServerRow[]; isLoading: boolean } {
  const queryClient = useQueryClient();

  const { data = [], isLoading } = useQuery<CapabilityRow[]>({
    queryKey: QUERY_KEY,
    queryFn: async () =>
      (await apiClient.get<CapabilityRow[]>('/graph/capability?include_system=true')) ?? [],
    staleTime: 30_000,
  });

  // A server added to a vendor config mid-edit should appear once the probe
  // picks it up. Invalidate on ops rather than polling.
  const onOp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);
  useEntityOps(WATCHED_TYPES, onOp as never);

  const servers = useMemo(() => {
    // No worker, no list. Every row here is worker-specific, so showing all of
    // them while the worker is unresolved would assert availability that is
    // false for whichever worker the agent turns out to use — the caller
    // renders an explanatory empty state instead.
    if (!workerType) return [];

    // Both sides folded to the driver short-id first. A capability kind spells
    // the worker in the `worker_type` vocabulary (`claude_code`) while
    // `agent.md` declares the driver key (`claude`), so comparing them raw
    // matched nothing for Claude — the exact two-vocabulary trap
    // `agent-vocabularies` warns about.
    const selected = toDriverKey(workerType);

    const rows: McpServerRow[] = [];
    for (const row of data) {
      const parts = (row.kind ?? '').split('.');
      // `<service>.mcp.<worker_type>` — exactly three segments. Anything else
      // is a different capability family (`harness.claude.cli`, `browsing.…`).
      if (parts.length !== 3 || parts[1] !== 'mcp') continue;
      if (toDriverKey(parts[2]) !== selected) continue;
      const worker = parts[2];
      rows.push({
        id: row.kind ?? '',
        // The capability's display name is "<server> (MCP / <worker>)"; the
        // suffix is the row's own context here, so it is stripped rather than
        // repeated on every line.
        name: (row.name ?? parts[0]).replace(/\s*\(MCP\s*\/\s*[^)]*\)\s*$/, ''),
        workerType: worker,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [data, workerType]);

  return { servers, isLoading };
}
