import { Box, ExternalLink, FolderOpen, FolderTree, User, type LucideIcon } from 'lucide-react';
import {
  assetSourceLabel,
  dataManager,
  isReadOnlySource,
  TypeId,
  type AssetDescriptor,
  type AssetSource,
} from '@sdk';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import flowpadIcon from '@src/assets/flowpad-icon.png';
import { basename } from './asset-row-helpers';

/**
 * The scope axis: WHERE an asset lives, as one chip.
 *
 * `AssetSource` answers this already — the enum is location-shaped by
 * construction (see its comment in `flow_sdk/builtin/agentic_process`). This
 * module is the presentation of it: a source plus its `source_dir`/`project_id`
 * collapse into an icon, a short name, and a file to reveal. Nothing here reads
 * the `usage[]` axis; how an asset came to be used is the row's business (which
 * section it lands in), never the chip's.
 *
 * Derived entirely client-side — no new wire field, and deliberately so. This is
 * NOT the entity's persisted `scope` column (which shares the words "system" /
 * "user" / "project" but answers a different question: that one is machine-global
 * and process-independent, so it can't say which project, nor that one skill is
 * `embedded` here and `project_dir` in the process next door). What this adds on
 * top of the source — icon, chip copy, read-only reason, a project displayName
 * from the client cache — is presentation, which the wire has no business
 * freezing.
 */
export type AssetScopeKind = 'agent' | 'user' | 'project' | 'context' | 'folder' | 'system' | 'external';

export interface AssetScope {
  kind: AssetScopeKind;
  /** Short chip text: 'this agent' | 'user' | <project name> | <folder> | 'system' | 'external'. */
  label: string;
  /** File to reveal in the OS file browser; null when there is nothing on disk. */
  revealPath: string | null;
  /** Multi-line title, including why the row is read-only. */
  tooltip: string;
}

/**
 * Why a row can't be edited in place, per scope. The lock icon these lines used
 * to hang off is gone — a column that renders for almost every row earns its
 * width poorly — so they ride on the scope chip, which is the thing that made
 * the row read-only in the first place.
 */
const READONLY_REASON: Record<AssetScopeKind, string | null> = {
  agent: null,
  user: 'Defined in your user folder — edits propagate to every process you run. Attach to get a private editable copy.',
  project:
    'Defined in the project — edits propagate to every process under this project. Attach to get a private editable copy.',
  context:
    'Lives in one of the project’s context folders — edits propagate everywhere that folder is referenced. Attach to get a private editable copy.',
  folder:
    'Lives outside the project — edits propagate everywhere this path is referenced. Attach to get a private editable copy.',
  system: 'Ships with Flowpad — a new version replaces it on upgrade. Attach to get a private editable copy.',
  external: 'Read-only from this process. Attach to get a private editable copy.',
};

const KIND_BY_SOURCE: Record<AssetSource, AssetScopeKind> = {
  embedded: 'agent',
  inline: 'agent',
  user_dir: 'user',
  project_dir: 'project',
  // A context folder is its own scope, not just another directory — it's the one
  // the project deliberately pulled in, so it gets the context-folder glyph the
  // rest of the app uses rather than a generic folder.
  context_dir: 'context',
  additional_dir: 'folder',
  workdir: 'folder',
  system: 'system',
  external: 'external',
};

function projectLabel(descriptor: AssetDescriptor): string | null {
  if (!descriptor.project_id) return null;
  try {
    return dataManager.getByTypeIdFromCache(new TypeId('project', descriptor.project_id))?.displayName ?? null;
  } catch {
    return null;
  }
}

export function assetScope(descriptor: AssetDescriptor): AssetScope {
  const kind = KIND_BY_SOURCE[descriptor.source] ?? 'external';
  const dir = descriptor.source_dir ? basename(descriptor.source_dir) : null;
  // assetSourceLabel, not the raw map: an unknown source from a newer backend
  // renders as itself rather than `undefined`, matching isReadOnlySource's
  // fail-soft stance on the same skew.
  const fallback = assetSourceLabel(descriptor.source);

  const label =
    kind === 'agent' ? 'this agent'
    : kind === 'project' ? projectLabel(descriptor) ?? dir ?? fallback
    : kind === 'context' || kind === 'folder' ? dir ?? fallback
    : fallback;

  const reason = isReadOnlySource(descriptor.source) ? READONLY_REASON[kind] : null;
  return {
    kind,
    label,
    revealPath: descriptor.posix_path ?? null,
    tooltip: scopeTooltip(
      label,
      descriptor.source_dir,
      descriptor.posix_path ?? '(no file — inline persona)',
      reason,
    ),
  };
}

/**
 * Scope of a bare additional-dir row (the directory itself, not an asset in it).
 * Routed through the same model so the chip can't drift from the assets inside
 * it — a hand-rolled row here is how the dir ends up wearing a different glyph
 * than its own contents.
 */
export function additionalDirScope(path: string): AssetScope {
  const kind: AssetScopeKind = KIND_BY_SOURCE.additional_dir;
  return {
    kind,
    label: basename(path) || path,
    revealPath: path,
    tooltip: scopeTooltip(basename(path) || path, path, null, READONLY_REASON[kind]),
  };
}

function scopeTooltip(
  label: string,
  sourceDir: string | null | undefined,
  posixPath: string | null | undefined,
  reason: string | null,
): string {
  return [
    label,
    sourceDir ? `from: ${sourceDir}` : null,
    posixPath ?? null,
    reason,
  ]
    .filter(Boolean)
    .join('\n');
}

const LUCIDE_BY_KIND: Record<Exclude<AssetScopeKind, 'project' | 'system'>, LucideIcon> = {
  agent: Box,
  user: User,
  context: FolderTree,
  folder: FolderOpen,
  external: ExternalLink,
};

function ScopeGlyph({ scope }: { scope: AssetScope }) {
  const className = 'h-3.5 w-3.5 flex-shrink-0';
  if (scope.kind === 'system') {
    return <img src={flowpadIcon} alt="" className={cn(className, 'rounded-[2px] object-contain')} />;
  }
  // Per the type-icon rule the project glyph is backend-owned, never hardcoded.
  const Icon = scope.kind === 'project' ? iconForType('project') : LUCIDE_BY_KIND[scope.kind];
  return <Icon className={cn(className, 'text-muted-foreground')} />;
}

/**
 * The scope icon + name pair. The icon reveals the asset's own file in the OS
 * file browser; with no file (an inline persona) it renders inert rather than
 * offering a click that would do nothing.
 */
export function AssetScopeChip({ scope, testidSuffix }: { scope: AssetScope; testidSuffix: string }) {
  const revealPath = scope.revealPath;
  return (
    <>
      {revealPath ? (
        <button
          type="button"
          className="flex items-center justify-center rounded hover:bg-muted"
          title={`${scope.tooltip}\n\nClick to reveal in the file browser`}
          data-testid={`asset-manager-scope-${testidSuffix}`}
          onClick={() => void openExternalFromComputeNode('@local', revealPath, { select: true })}
        >
          <ScopeGlyph scope={scope} />
        </button>
      ) : (
        <span className="flex items-center justify-center" title={scope.tooltip}>
          <ScopeGlyph scope={scope} />
        </span>
      )}
      <span className="min-w-0 truncate text-[10px] uppercase tracking-wider text-muted-foreground">
        {scope.label}
      </span>
    </>
  );
}
