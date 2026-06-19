import { MarkdownEditor, type MarkdownHeaderExtrasCtx } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { SkillEvalPanel } from '@src/components/assets/editor/skill/SkillEvalPanel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { FSRef, Skill } from '@sdk';
import { cn } from '@src/lib/utils';
import { FlaskConical } from 'lucide-react';
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
 * Skill asset editor — the SKILL.md editor with its Chat + Backlinks side
 * window (keyed on the skill entity's typeId). The skill's other files are
 * browsed/created/deleted from the Assets sidebar, where the skill row expands
 * into its folder tree (see the `skillFolder` adapter) — there is no second
 * tree here.
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

  const onDelete = useCallback(async () => {
    if (!skill) return;
    await skill.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [skill, navigation]);

  // Header eval toggle — flips the `eval` frontmatter flag through the editor's
  // own content buffer (single writer; see MarkdownHeaderExtrasCtx). `eval`
  // round-trips as the string 'true'/'false'.
  const headerExtras = useCallback(({ fields, setField }: MarkdownHeaderExtrasCtx) => {
    const isEval = fields.eval === 'true';
    return (
      <button
        type="button"
        onClick={() => setField('eval', isEval ? 'false' : 'true')}
        aria-pressed={isEval}
        title={isEval ? 'Under eval — click to stop evaluating' : 'Mark skill for eval'}
        data-testid="skill-eval-toggle"
        className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors',
          isEval
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <FlaskConical className="h-4 w-4" />
      </button>
    );
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-w-0 flex-1">
        <MarkdownEditor
          fsRef={editorRef}
          chatTarget={chatTarget}
          headerExtras={headerExtras}
          onDelete={skill ? onDelete : undefined}
          deleteLabel={skill?.name ?? undefined}
        />
      </div>
      {skill && <SkillEvalPanel skill={skill} />}
    </div>
  );
}
