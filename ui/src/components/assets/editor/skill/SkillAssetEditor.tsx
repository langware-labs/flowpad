import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { EditableFileTree } from '@src/components/directory-tree';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { dataContext, FSRef, Skill } from '@sdk';
import { useCallback } from 'react';
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
 * Skill assets render a two-pane surface — an editable file tree on the left
 * (browse + add/delete files in the skill folder), SKILL.md editor on the right.
 * The file tree reuses the canonical `DirectoryTree` via `EditableFileTree`,
 * rooted at the skill folder on the local compute node.
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

  const computeNodeTypeId = dataContext.computeNodeTypeId;

  const onDelete = useCallback(async () => {
    if (!skill) return;
    await skill.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [skill, navigation]);

  return (
    <div className="skill-editor-container">
      {computeNodeTypeId && skill?.asset_ref && (
        <div className="skill-editor-sidebar">
          <EditableFileTree
            rootTypeId={computeNodeTypeId}
            rootPath={skill.asset_ref}
            rootLabel={skill.name}
            className="h-full"
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
