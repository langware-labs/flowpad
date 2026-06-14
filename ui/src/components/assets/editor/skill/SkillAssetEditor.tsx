import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { FSRef, Skill } from '@sdk';
import { useCallback } from 'react';

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
 * Skill assets render a single surface — the SKILL.md editor with its
 * Chat + Backlinks side window (keyed on the skill entity's typeId). The
 * editor takes the full height; there is no bottom execution panel.
 */
export function SkillAssetEditor({ fsRef, skill: providedSkill }: SkillAssetEditorProps) {
  const { entity: discoveredSkill } = useEntityByPath<Skill>(
    providedSkill ? null : Skill.type,
    providedSkill ? null : fsRef,
  );
  const skill = providedSkill ?? discoveredSkill;
  const editorRef = skill?.doc ?? fsRef.child('SKILL.md');
  // chatTarget MUST be the entity's TypeId — MarkdownEditor builds `new TypeId(chatTarget)`.
  // Passing a path here is what caused the "Invalid typeId" crash.
  const chatTarget = skill ? skill.typeId.toString() : null;
  const { navigation } = useDockNavigation();
  const onDelete = useCallback(async () => {
    if (!skill) return;
    await skill.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [skill, navigation]);
  return (
    <div className="h-full min-h-0">
      <MarkdownEditor
        fsRef={editorRef}
        chatTarget={chatTarget}
        onDelete={skill ? onDelete : undefined}
        deleteLabel={skill?.name ?? undefined}
      />
    </div>
  );
}
