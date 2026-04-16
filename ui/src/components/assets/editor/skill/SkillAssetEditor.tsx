import { MarkdownAssetEditor } from '@src/components/assets/editor/markdown/MarkdownAssetEditor';
import { FSRef } from '@sdk';

interface SkillAssetEditorProps {
  /** FSRef to the skill folder. SKILL.md is resolved via child(). */
  fsRef: FSRef;
}

/**
 * Thin wrapper around MarkdownAssetEditor for skill assets.
 * Skills are folders; the content lives at <folder>/SKILL.md.
 */
export function SkillAssetEditor({ fsRef }: SkillAssetEditorProps) {
  return <MarkdownAssetEditor fsRef={fsRef.child('SKILL.md')} />;
}
