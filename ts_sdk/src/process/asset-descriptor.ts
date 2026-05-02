/**
 * Mirrors `flow_sdk.builtin.agentic_process.agentic_process.AssetDescriptor`.
 *
 * Returned by `AgenticProcess.getAssets()`. Each descriptor identifies a
 * single (asset, source) pair visible to an AgenticProcess. The same source
 * asset may appear multiple times with different sources (e.g. EMBEDDED
 * + USER_DIR for a skill that's both materialized into the process and
 * globally discoverable).
 */
export type AssetSource =
  | 'embedded'        // materialized via embedded_asset_refs
  | 'inline'          // cli_config.agents_json / embedded_agent_ids — no file
  | 'project_dir'     // under project.fs_storage_mount_path
  | 'user_dir'        // under user_home
  | 'workdir'         // process workdir if distinct from project/user
  | 'additional_dir'; // additional_dirs entries (excl. auto-appended assets dir)

export interface AssetDescriptor {
  /** Serialized TypeId, e.g. "skill-<uuid>" or "agent-<uuid>". */
  typeid: string;
  source: AssetSource;
  /** Canonical POSIX path; null for INLINE. */
  posix_path: string | null;
}

/**
 * Human-readable short label for a source. Used for badges next to each
 * descriptor row in the asset-management UI.
 */
export const ASSET_SOURCE_LABEL: Record<AssetSource, string> = {
  embedded: 'embedded',
  inline: 'inline',
  project_dir: 'project',
  user_dir: 'user',
  workdir: 'workdir',
  additional_dir: 'additional',
};
