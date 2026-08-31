import { useEffect, useMemo, useState } from 'react';
import { Capability, capabilityManager } from '@sdk';

/** Second segment of a `<service>.mcp.<worker_type>` kind. */
const MCP_INFIX = 'mcp';

/**
 * True for a `<service>.mcp.<worker_type>` capability kind.
 *
 * Mirrors the backend's `is_mcp_capability_kind` exactly — second segment is
 * the infix. The SDK ships no helper for this, so the rule is restated rather
 * than approximated with a substring match (a service literally named "mcp"
 * would break that).
 */
export function isMcpCapabilityKind(kind: string): boolean {
  const parts = kind.trim().toLowerCase().split('.');
  return parts.length >= 3 && parts[1] === MCP_INFIX;
}

export interface McpServerRow {
  capability: Capability;
  /** `<service>` — the normalized token the backend derived from the server name. */
  service: string;
  /** `<worker_type>` — the config OWNER (claude_code, codex, …), not necessarily a runtime. */
  workerType: string;
}

/**
 * The MCP servers Flowpad knows about, read through the capability manager.
 *
 * There is no `mcp_server` graph route — that type has a TypeInfo but no entity
 * class, so it is not addressable. Every indexed MCP server is instead exposed
 * as a `<service>.mcp.<worker_type>` capability, which is a real entity, so the
 * capability list IS the server list.
 *
 * The manager is a shared singleton with its own cache: `load()` fetches once
 * (with `include_system=true`, which is required — every capability row is a
 * system row) and `subscribe` fires on every change, so mounting this in a
 * second place costs no extra request.
 */
export function useMcpCapabilities(): { servers: McpServerRow[]; isLoading: boolean } {
  // `getAll()` returns a fresh array per call, so this is held in state and
  // pushed by the subscription rather than read through useSyncExternalStore,
  // whose cached-snapshot contract that would violate.
  const [capabilities, setCapabilities] = useState<Capability[]>(() => capabilityManager.getAll());
  const [isLoading, setIsLoading] = useState(() => capabilityManager.getAll().length === 0);

  useEffect(() => {
    let live = true;
    const sync = () => {
      if (live) setCapabilities(capabilityManager.getAll());
    };
    const unsubscribe = capabilityManager.subscribe(sync);
    void capabilityManager
      .load()
      .then(sync)
      .finally(() => {
        if (live) setIsLoading(false);
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const servers = useMemo(() => {
    const rows = capabilities
      .filter((capability) => isMcpCapabilityKind(capability.kind))
      .map((capability) => {
        const [service, , workerType = ''] = capability.kind.split('.');
        return { capability, service, workerType };
      });
    // Service first, then worker type: the same server configured for two
    // harnesses reads as two adjacent rows rather than two unrelated ones.
    return rows.sort(
      (a, b) => a.service.localeCompare(b.service) || a.workerType.localeCompare(b.workerType),
    );
  }, [capabilities]);

  return { servers, isLoading };
}
