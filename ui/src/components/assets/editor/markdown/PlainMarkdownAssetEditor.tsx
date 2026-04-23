import { MarkdownEditor } from './MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
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
 * Resolves the backing entity by `source_path` so Chat + Backlinks tabs key
 * on the real TypeId (`"plan-<uuid>"`, …) instead of a path-based pseudo.
 */
export function PlainMarkdownAssetEditor({ fsRef, assetType }: PlainMarkdownAssetEditorProps) {
  const { entity } = useEntityByPath<APIEntity<APIEntity<any>>>(assetType, fsRef);
  const chatTarget = entity ? entity.typeId.toString() : null;
  return <MarkdownEditor fsRef={fsRef} chatTarget={chatTarget} />;
}
