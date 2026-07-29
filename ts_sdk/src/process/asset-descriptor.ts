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
  | 'additional_dir'  // additional_dirs entries (excl. auto-appended assets dir)
  | 'context_dir'     // project.include_dirs (context folders)
  | 'system'          // bundled flowpad_assistant assets
  | 'external';       // not attributable to any of this process's source dirs

export type AssetUsageKind =
  | 'embedded_asset'
  | 'inline_persona'
  | 'transcript_file_read';

export interface AssetUsage {
  /** Normalized reason this descriptor is considered active/used. */
  kind: AssetUsageKind;
  path?: string | null;
  entry_id?: string | null;
  timestamp?: string | null;
  label?: string | null;
}

export interface AssetDescriptor {
  /** Serialized TypeId, e.g. "skill-<uuid>" or "agent-<uuid>". */
  typeid: string;
  source: AssetSource;
  /** Canonical POSIX path; null for INLINE. */
  posix_path: string | null;
  /** Matched source dir for path-discovered assets; null for EMBEDDED/INLINE. */
  source_dir?: string | null;
  /** Project id stamped on the backing entity record; null for user-scoped or
   *  process-local (embedded/inline/workdir) assets. Lets scope-aware UIs
   *  filter by specific project ids without re-fetching. */
  project_id?: string | null;
  /** Whether the backing entity has a cloud counterpart. Omitted by older servers. */
  remote?: boolean;
  /** Lightweight usage evidence owned by the backend. */
  usage?: AssetUsage[];
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
  context_dir: 'context folder',
  system: 'system',
  external: 'external',
};

/**
 * The only sources this process may write: ``embedded`` (a private materialized
 * copy in the process's own assets dir) and ``inline`` (lives in this process's
 * ``cli_config``). Everything else lives outside the process — editing it would
 * propagate elsewhere (other processes, the project, the user globally, a
 * pip-installed package), so it is "read-only" from this process's perspective.
 * To get an editable copy, attach the asset (which materializes an EMBEDDED row).
 *
 * Expressed as an allowlist rather than a read-only denylist so that the
 * predicate below fails CLOSED: this SDK ships separately from the Python wheel,
 * so a stale bundle can meet a source string it has never heard of. Under a
 * denylist that unknown source reads as writable, which would hand the user a
 * live editor over (say) a file inside site-packages. The writable set is closed
 * and process-local by definition; any future source is far likelier to be one
 * more place we must not write to.
 */
export const WRITABLE_ASSET_SOURCES: readonly AssetSource[] = ['embedded', 'inline'];

export function isReadOnlySource(source: AssetSource | string): boolean {
  return !WRITABLE_ASSET_SOURCES.includes(source as AssetSource);
}

/** The read-only complement of {@link WRITABLE_ASSET_SOURCES}, for known sources. */
export const READONLY_ASSET_SOURCES: readonly AssetSource[] = (
  Object.keys(ASSET_SOURCE_LABEL) as AssetSource[]
).filter(isReadOnlySource);

/** Label for a source, tolerating one this bundle predates (renders it raw). */
export function assetSourceLabel(source: AssetSource | string): string {
  return ASSET_SOURCE_LABEL[source as AssetSource] ?? String(source);
}

export function assetDescriptorHasUsage(descriptor: Pick<AssetDescriptor, 'usage'>): boolean {
  return (descriptor.usage?.length ?? 0) > 0;
}
