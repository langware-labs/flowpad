import { Skill } from '@sdk';
import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback } from 'react';

interface SkillEditorProps {
  /** Pre-resolved skill entity from AssetEditorRouter */
  skill: Skill;
  /** Optional callback when skill is updated */
  onSkillUpdated?: () => void;
}

/**
 * Skill editor using the standard MarkdownEditor component.
 *
 * Skills are YAML-frontmatter markdown files with the following frontmatter:
 * - id: UUID
 * - name: skill name
 * - description: brief description
 * - tags: optional array
 * - allowedTools: optional array
 *
 * The body is markdown content rendered by Milkdown.
 */
export function SkillEditor({ skill, onSkillUpdated }: SkillEditorProps) {
  const { navigation } = useDockNavigation();

  const skillMarkdownRef = skill.doc;
  const chatTarget = skill.typeId.toString();

  const handleDelete = useCallback(async () => {
    await skill.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [skill, navigation]);

  return (
    <MarkdownEditor
      fsRef={skillMarkdownRef}
      chatTarget={chatTarget}
      onDelete={handleDelete}
      deleteLabel={skill.name}
    />
  );
}
