import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { AgenticProcess, FSRef, ProcessType, Skill } from '@sdk';
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
 * Skill assets render two surfaces, mirroring AgentAssetEditor:
 *   - Side-drawer editor process — keyed on SKILL.md's vpath.
 *   - Bottom skill execution — keyed on the skill entity's typeId; first
 *     send symlinks the live skill folder under the process's assets dir
 *     so Claude Code discovers it via --add-dir at startup.
 */
export function SkillAssetEditor({ fsRef, skill: providedSkill }: SkillAssetEditorProps) {
  const { entity: discoveredSkill } = useEntityByPath<Skill>(
    providedSkill ? null : Skill.type,
    providedSkill ? null : fsRef,
  );
  const skill = providedSkill ?? discoveredSkill;
  const editorRef = skill?.doc ?? fsRef.child('SKILL.md');
  const sourcePath = skill?.asset_ref ?? fsRef.path;
  const loadSkill = useCallback(
    async (proc: AgenticProcess) => {
      await proc.loadEmbeddedSkill(sourcePath);
    },
    [sourcePath],
  );
  // chatTarget MUST be the entity's TypeId — MarkdownEditor builds `new TypeId(chatTarget)`.
  // Passing a path here is what caused the "Invalid typeId" crash.
  const chatTarget = skill ? skill.typeId.toString() : null;
  const skillExecutionTarget = skill ? skill.typeId.toString() : null;
  const { navigation } = useDockNavigation();
  const onDelete = useCallback(async () => {
    if (!skill) return;
    await skill.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [skill, navigation]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <MarkdownEditor
          fsRef={editorRef}
          chatTarget={chatTarget}
          onDelete={skill ? onDelete : undefined}
          deleteLabel={skill?.name ?? undefined}
        />
      </div>
      {skillExecutionTarget && (
        <div className="h-[300px] flex-shrink-0 border-t" data-testid="skill-execution">
          <EntityExecutionPanel
            target={skillExecutionTarget}
            processType={ProcessType.Execution}
            onProcessCreated={loadSkill}
            headerLabel="Skill execution"
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
