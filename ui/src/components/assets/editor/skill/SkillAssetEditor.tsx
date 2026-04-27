import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { FSRef, Skill } from '@sdk';

interface SkillAssetEditorProps {
  /** FSRef to the skill folder. SKILL.md is resolved via child(). */
  fsRef: FSRef;
}

/**
 * Thin wrapper around MarkdownEditor for skill assets.
 * Skills are folders; the content lives at <folder>/SKILL.md. Chat keys on
 * the folder-level Skill entity, not on SKILL.md itself.
 */
export function SkillAssetEditor({ fsRef }: SkillAssetEditorProps) {
  const { entity: skill } = useEntityByPath<Skill>(Skill.type, fsRef);
  return (
    <MarkdownEditor
      fsRef={fsRef.child('SKILL.md')}
      chatTarget={skill ? skill.typeId.toString() : null}
    />
  );
}
