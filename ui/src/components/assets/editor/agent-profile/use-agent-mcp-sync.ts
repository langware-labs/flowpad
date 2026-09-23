import { useEffect, useMemo, useRef } from 'react';
import { Mcp, type AssetDescriptor } from '@sdk';
import { basename, displayLabelForDescriptor } from '@src/components/asset-manager';
import { useStagedAssets } from '@src/components/agent-resources/useStagedAssets';

/** Row label. `displayLabelForDescriptor` gives up at the raw typeid for an
 *  asset this pane never cached; an MCP asset's identity IS its folder, so the
 *  basename is the answer — applied only on that give-up path. */
function labelFor(d: AssetDescriptor): string {
  const label = displayLabelForDescriptor(d);
  return label === d.typeid && d.posix_path ? basename(d.posix_path) : label;
}

/**
 * The agent's MCP slot — the ids that reach `mcp_servers:` in `agent.md`. Headless: the servers
 * are shown in the agent-resources menu on the left, so the editor shows no second list.
 *
 * TEMPORARY POLICY: every MCP asset in the project is attached. There is no
 * picker yet, so the field is derived rather than edited, and it commits itself
 * whenever the project's set of MCP assets stops matching what `agent.md`
 * declares. `save()` diffs the rendered document, so a commit that changes
 * nothing writes nothing.
 *
 * Deliberately NOT worker-filtered. An `Mcp` asset carries no `worker_type` —
 * it is ours end to end and renders into whichever harness runs (see
 * `cli_drivers/mcp_projection.py`), so there is nothing to filter on and the
 * list does not move when the Worker field does. The driver still decides
 * whether a server is ACCEPTABLE: `Agent.add_mcp` validates every spec through
 * `prepare_process_mcp` at attach time, which is what refuses e.g. a dotted
 * server name under codex.
 *
 * The vendor-configured servers the agent-resources pane also lists are NOT
 * here on purpose: those are `capability` rows describing someone else's config
 * file, and attaching one would mean adopting a definition site we do not own.
 */
export function useAgentMcpSync(
  /** What `agent.md` currently declares. */
  value: string[] | null | undefined,
  onCommit: (ids: string[]) => void,
): void {
  const { descriptors, isLoading } = useStagedAssets(Mcp.type);

  // Deduped by typeid and sorted, in that order. `useStagedAssets` returns one
  // row per (typeid, source) — the pane wants that distinction, a declaration
  // list does not, and sorting is what keeps the derived value stable enough to
  // compare against the committed one.
  const rows = useMemo(() => {
    const byId = new Map<string, { typeid: string; label: string }>();
    for (const d of descriptors) {
      if (!byId.has(d.typeid)) byId.set(d.typeid, { typeid: d.typeid, label: labelFor(d) });
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [descriptors]);

  const ids = useMemo(() => rows.map((r) => r.typeid), [rows]);

  const committed = (value ?? []).join('\0');
  const desired = ids.join('\0');

  // The commit we last issued, so an in-flight save is not re-issued every
  // render. `onCommit` is an inline arrow at the call site (fresh identity per
  // render) and `value` only catches up once the write round-trips, so without
  // this the effect would fire in a loop for the whole duration of the save.
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    // Committing while the read is still in flight would declare an empty list
    // and then immediately correct it — two writes, and a window where the
    // agent genuinely has none.
    if (isLoading) return;
    if (desired === committed) {
      sentRef.current = null;
      return;
    }
    if (sentRef.current === desired) return;
    sentRef.current = desired;
    onCommit(ids);
  }, [committed, desired, ids, isLoading, onCommit]);
}
