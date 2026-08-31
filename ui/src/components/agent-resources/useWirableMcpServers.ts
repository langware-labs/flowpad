import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';

const QUERY_KEY = ['agent-resources', 'mcp-servers'] as const;

/** Module-scope: `useEntityOps` keys its effect on the array's IDENTITY. */
const WATCHED_TYPES = ['mcp_server'];

/** Bounded like the skills list — this is a picker, not a browser. */
const LIMIT = 200;

interface McpSearchResult {
  record_id: string;
  name?: string;
  scope?: string;
}

export interface McpServerRow {
  /** Serialized TypeId — the value `agent.mcp_servers` stores. */
  id: string;
  name: string;
  /** `user` | `project` | `local` — which config file scope declared it. */
  scope: string;
}

/**
 * The MCP servers that can be wired into an agent.
 *
 * Read through `/search`, NOT the capability manager, and that choice is forced
 * by the id: `agent.mcp_servers` is `list[TypeId]`, and a capability's id
 * identifies the CAPABILITY (`capability-<uuid>`), not the server. The
 * capability row carries no pointer back either — its `value` is null for MCP
 * kinds — so it can list servers but can never say which one to store.
 * `mcp_server` records have their own ids, so they are the wirable identity.
 *
 * `include_system=true` is required: these records are system-scoped, and
 * without the flag the search returns nothing at all.
 *
 * (There is still no `/graph/mcp_server` route — the type has a TypeInfo but no
 * entity class — which is why this goes through `/search` rather than the graph
 * route the skills list uses.)
 */
export function useWirableMcpServers(): { servers: McpServerRow[]; isLoading: boolean } {
  const queryClient = useQueryClient();

  const { data = [], isLoading } = useQuery<McpSearchResult[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const params = new URLSearchParams({
        record_type: 'mcp_server',
        q: '',
        offset: '0',
        limit: String(LIMIT),
        include_system: 'true',
      });
      const body = (await apiClient.get<{ results?: McpSearchResult[] }>(`/search?${params.toString()}`)) ?? null;
      return body?.results ?? [];
    },
    staleTime: 30_000,
  });

  // A server added to a vendor config mid-edit should appear once indexing
  // picks it up. Invalidate on ops rather than polling.
  const onOp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);
  useEntityOps(WATCHED_TYPES, onOp as never);

  const servers = useMemo(() => {
    const rows = data
      .filter((r) => r.record_id)
      .map((r) => ({
        // Same construction as a skill's `typeId.toString()`: `<type>-<uuid>`.
        id: `mcp_server-${r.record_id}`,
        name: r.name || r.record_id,
        scope: r.scope || '',
      }));
    // One row per server NAME. The same server declared in several config files
    // indexes as several records (identity is derived from the config path), and
    // a picker should offer it once.
    const byName = new Map<string, McpServerRow>();
    for (const row of rows) if (!byName.has(row.name)) byName.set(row.name, row);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  return { servers, isLoading };
}
