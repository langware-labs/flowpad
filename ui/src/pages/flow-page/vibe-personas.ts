/**
 * The SDK-shipped sub-agents a vibe session rides — resolved ONCE per app life
 * through the raw include_system route (system assets only surface with it).
 * Both resolvers select off the same listing: the standard `vibe` persona and
 * every system-scope `kind: vibe` persona (e.g. `data-integrations`).
 * A failed listing is not cached so a late-indexed asset is picked up next time.
 */
import apiClient from '@sdk/client';
import { AgentKind } from '@sdk';

export interface SystemSubagentRow {
  name?: string;
  kind?: string;
  scope?: string;
  asset_ref?: string;
  created_date?: string;
}

let listing: SystemSubagentRow[] | null = null;

export async function systemSubagents(): Promise<SystemSubagentRow[]> {
  if (listing) return listing;
  const rows = await apiClient.get<SystemSubagentRow[]>('/graph/subagent?include_system=true');
  const system = (rows ?? []).filter((r) => r.scope === 'system');
  if (system.length) listing = system;
  return system;
}

/** asset_ref of the system sub-agent named `name`, or null when not indexed. */
export async function systemSubagentRef(name: string): Promise<string | null> {
  return (await systemSubagents()).find((r) => r.name === name)?.asset_ref ?? null;
}

/** asset_refs of the system-scope `kind==vibe` personas, created-date order. */
export async function systemVibeKindSubagentRefs(): Promise<string[]> {
  return (await systemSubagents())
    .filter((r) => r.kind === AgentKind.Vibe && r.asset_ref)
    .sort((a, b) => String(a.created_date ?? '').localeCompare(String(b.created_date ?? '')))
    .map((r) => r.asset_ref as string);
}
