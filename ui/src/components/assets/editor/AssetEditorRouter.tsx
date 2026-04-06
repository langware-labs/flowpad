import { MarkdownAssetEditor } from './markdown/MarkdownAssetEditor';
import { DocsAssetEditor } from './docs/DocsAssetEditor';
import { SkillAssetEditor } from './skill/SkillAssetEditor';

interface AssetEditorRouterProps {
  /** Pointer in the format "editor/<type>/<vfsPath>" */
  pointer: string;
}

/**
 * Routes an asset editor pointer to the appropriate type-specific editor.
 *
 * Pointer format: "editor/<assetType>/<vfsPath...>"
 * Examples:
 *   "editor/skill//Users/shlom/.claude/skills/my-skill"
 *   "editor/docs//Users/shlom/docs/readme.md"
 */
export function AssetEditorRouter({ pointer }: AssetEditorRouterProps) {
  // Parse pointer: "editor/<type>/<rest...>" — rest is the VFS/filesystem path
  const parts = pointer.split('/');
  const assetType = parts[1] ?? '';
  // Rejoin remaining parts to reconstruct the path (it may contain slashes).
  // The leading "/" of an absolute machine path gets dropped by URL normalization
  // (e.g. "editor/skill//Users/..." → "editor/skill/Users/..."), so restore it.
  const rawPath = parts.slice(2).join('/');
  const vfsPath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;

  switch (assetType) {
    case 'skill':
      return <SkillAssetEditor sourcePath={vfsPath} />;
    case 'docs':
      return <DocsAssetEditor sourcePath={vfsPath} />;
    case 'claude_md':
    case 'claude_memory':
    case 'claude_rules':
    case 'agent':
    case 'command':
    case 'plan':
    case 'workflow':
    case 'asset':
      return <MarkdownAssetEditor sourcePath={vfsPath} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No editor for type: {assetType}
        </div>
      );
  }
}
