import { MarkdownEditor } from './MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { dataContext, FrontMatterFsRef } from '@sdk';
import type { APIEntity, FSRef } from '@sdk';

interface PlainMarkdownAssetEditorProps {
  /** FSRef to the .md file. */
  fsRef: FSRef;
  /** Entity type string (e.g. `"plan"`, `"claude_md"`, `"markdown"`). */
  assetType: string;
}

/**
 * Thin wrapper for markdown asset types that don't have a dedicated editor
 * (plan, claude_md, claude_memory, claude_rules, command, markdown).
 *
 * Resolves the backing entity by `asset_ref` so Chat + Backlinks tabs key
 * on the real TypeId (`"plan-<uuid>"`, …) instead of a path-based pseudo.
 *
 * Editor body is read from `entity.asset_ref` (the canonical user-owned path
 * stored on the entity) once the entity resolves; falls back to the URL-derived
 * fsRef while loading. Both resolve to the same file post mount-path fix.
 */
export function PlainMarkdownAssetEditor({ fsRef, assetType }: PlainMarkdownAssetEditorProps) {
  const { entity } = useEntityByPath<APIEntity<APIEntity<any>>>(assetType, fsRef);
  const chatTarget = entity ? entity.typeId.toString() : null;
  const assetRef = (entity as { asset_ref?: string } | null)?.asset_ref;
  const localTypeId = dataContext.computeNodeTypeId;
  const editorRef =
    assetRef && localTypeId ? new FrontMatterFsRef(assetRef, localTypeId) : fsRef;
  return <MarkdownEditor fsRef={editorRef} chatTarget={chatTarget} />;
}
