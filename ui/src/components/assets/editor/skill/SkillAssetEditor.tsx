import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { FSRef, Skill, apiClient } from '@sdk';
import { useCallback, useEffect, useState } from 'react';
import SkillFileTree, { TreeNode } from '@src/components/skill-editor/SkillFileTree';
import './SkillAssetEditor.css';

interface SkillAssetEditorProps {
  /** FSRef to the skill folder. SKILL.md is resolved via child(). */
  fsRef: FSRef;
  /**
   * Pre-resolved skill entity. Passed by `<EntityResolutionGate>` from
   * `AssetEditorRouter`. When omitted (direct-mount callers), the editor
   * falls back to `useEntityByPath` for backwards compatibility.
   */
  skill?: Skill;
}

/**
 * Skill assets render a two-pane surface — file tree on the left, SKILL.md editor (or selected file)
 * on the right. The editor takes the full height; there is no bottom execution panel.
 */
export function SkillAssetEditor({ fsRef, skill: providedSkill }: SkillAssetEditorProps) {
  const { entity: discoveredSkill } = useEntityByPath<Skill>(
    providedSkill ? null : Skill.type,
    providedSkill ? null : fsRef,
  );
  const skill = providedSkill ?? discoveredSkill;
  const editorRef = skill?.doc ?? fsRef.child('SKILL.md');
  const chatTarget = skill ? skill.typeId.toString() : null;
  const { navigation } = useDockNavigation();

  // Fetch and cache the skill folder tree
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [isLoadingTree, setIsLoadingTree] = useState(true);

  useEffect(() => {
    if (!skill?.id) return;

    const fetchTree = async () => {
      try {
        const response = await apiClient.get(`/api/v1/skills/${skill.id}/tree`);
        setTree(response.data.tree);
      } catch (error) {
        console.error('Failed to fetch skill tree:', error);
      } finally {
        setIsLoadingTree(false);
      }
    };

    fetchTree();
  }, [skill?.id]);

  const onDelete = useCallback(async () => {
    if (!skill) return;
    await skill.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [skill, navigation]);

  const onSelectFile = useCallback(
    (absolutePath: string) => {
      // Navigate to code editor for the selected file
      navigation.openDock(DockPointer.forAssetEditor('code', absolutePath));
    },
    [navigation]
  );

  return (
    <div className="skill-editor-container">
      {tree && skill?.asset_ref && !isLoadingTree && (
        <div className="skill-editor-sidebar">
          <SkillFileTree
            tree={tree}
            skillFolder={skill.asset_ref}
            onSelectFile={onSelectFile}
          />
        </div>
      )}
      <div className="skill-editor-main">
        <MarkdownEditor
          fsRef={editorRef}
          chatTarget={chatTarget}
          onDelete={skill ? onDelete : undefined}
          deleteLabel={skill?.name ?? undefined}
        />
      </div>
    </div>
  );
}
