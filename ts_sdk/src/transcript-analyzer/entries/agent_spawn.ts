/**
 * AgentSpawnEntry — an agent dispatched a sub-agent (Task / SubAgent tool).
 *
 * Mirrors flow_sdk/transcript_analyzer/entries/agent_spawn.py. The spawned
 * sub-agent's transcript is carried inline as `children` once the server has
 * assembled the tree (see assembly.assemble_tree); the recursion is rebuilt by
 * `fromJson` in ../index.ts, which hydrates each child and passes them in.
 */

import { EntryKind, TranscriptEntry, type TranscriptEntryBase } from '../entry';

export interface AgentSpawnEntryData extends TranscriptEntryBase {
  agent_type: string;
  prompt?: string | null;
  description?: string | null;
  tool_name?: string;
  tool_use_id?: string;
  children?: Record<string, unknown>[];
}

export class AgentSpawnEntry extends TranscriptEntry {
  override kind = EntryKind.AGENT_SPAWN;

  agent_type: string;
  prompt: string | null;
  description: string | null;
  tool_name: string;
  tool_use_id: string;
  /** Hydrated sub-agent subtree; empty when the transcript wasn't assembled. */
  children: TranscriptEntry[];

  constructor(data: AgentSpawnEntryData, children: TranscriptEntry[] = []) {
    super(data);
    this.agent_type = data.agent_type ?? '';
    this.prompt = data.prompt ?? null;
    this.description = data.description ?? null;
    this.tool_name = data.tool_name ?? '';
    this.tool_use_id = data.tool_use_id ?? '';
    this.children = children;
  }
}
