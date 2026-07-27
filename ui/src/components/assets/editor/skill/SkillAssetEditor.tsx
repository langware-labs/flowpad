import { MarkdownEditor, type MarkdownHeaderExtrasCtx } from '@src/components/assets/editor/markdown/MarkdownEditor';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { FSRef, ProcessKind, Skill } from '@sdk';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { FlaskConical, History } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';
import { UsagePanel } from './UsagePanel';

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
  const { navigation } = useDockNavigation();

  // Everything below is keyed on the STABLE typeId string, never the `skill`
  // object — so a metadata-only `save()` (which hands back a new `skill` ref via
  // useEntity) does NOT rebuild the header/tabs/editorRef and remount the panels.
  // That remount loop is what turned one eval-toggle PUT into ~30 refetches.
  // The live entity is read through a ref so callbacks still act on the current
  // object without depending on its identity.
  const skillRef = useRef(skill);
  skillRef.current = skill;
  const skillKey = skill ? skill.typeId.toString() : null;

  // Body re-read token: SKILL.md re-reads when the skill entity's `updated_date`
  // advances (a reindex from an agent turn-end / invalidate re-parsed the folder).
  // Scalar so it's stable across identity-only skill ref churn; dirty-guarded.
  const reloadKey = entityReloadKey((skill as { updated_date?: unknown } | undefined)?.updated_date);

  // Stable across metadata updates (same skillKey ⇒ same SKILL.md path) so the
  // editor doesn't re-download the file on every eval flip.
  // Keyed on the STABLE skillKey only — `skill.doc` mints a fresh FrontMatterFsRef
  // on every access, so including the (also per-render) `fsRef` here would churn
  // editorRef's identity every render and reload the MarkdownEditor. skillRef
  // holds the live skill; fsRef is stable for a given SKILL.md path anyway.
  const editorRef = useMemo(
    // Same guard as Skill.doc: a file-valued ref (already .../SKILL.md) must not
    // get the main file appended again, or the download 404s on SKILL.md/SKILL.md.
    () =>
      skillRef.current?.doc ??
      (fsRef.path.endsWith('/SKILL.md') ? fsRef : fsRef.child('SKILL.md')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillKey],
  );

  const onDelete = useCallback(async () => {
    const s = skillRef.current;
    if (!s) return;
    await s.delete();
    navigation.openDock(DockPointer.forAssetList(Skill.type));
  }, [navigation]);

  // Header eval toggle. Flipping it writes to BOTH layers so the flag takes
  // effect immediately and durably:
  //   1. SKILL.md frontmatter via the editor's content buffer (the durable
  //      source of truth; single writer — see MarkdownHeaderExtrasCtx).
  //   2. the Skill entity's `metadata.eval` via `save()` (the projection the
  //      rest of the app reads through `isEval`). Without (2) the flag wouldn't
  //      surface until a re-index re-walked this file — which isn't guaranteed
  //      (the file may live in a root the manual rescan doesn't re-walk), so
  //      the badge/auto-eval would silently never fire.
  // `eval` round-trips as the string 'true'/'false' (frontmatter is quoted).
  const headerExtras = useCallback(({ fields, setField }: MarkdownHeaderExtrasCtx) => {
    const isEval = fields.eval === 'true';
    const toggle = () => {
      const next = isEval ? 'false' : 'true';
      setField('eval', next);
      const s = skillRef.current;
      if (s) {
        s.metadata = { ...(s.metadata ?? {}), eval: next };
        void s.save().catch((e) => {
          notify.error({
            title: 'Could not update eval flag',
            message: e instanceof Error ? e.message : 'Save failed.',
          });
        });
      }
    };
    return (
      <button
        type="button"
        onClick={toggle}
        aria-pressed={isEval}
        title={isEval ? 'Under eval — click to stop evaluating' : 'Mark skill for eval'}
        data-testid="skill-eval-toggle"
        className={cn(
          'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors',
          isEval
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <FlaskConical className="h-3.5 w-3.5" />
      </button>
    );
    // Stable identity: reads the live skill via `skillRef`, so it never rebuilds
    // on a skill ref change (only `fields`/`setField` from the editor drive it).
  }, []);

  // Skill eval history rides as an extra tab inside the editor's single side
  // drawer (Chat | Backlinks | Eval) rather than a second sibling rail. The
  // analysis processes are launched elsewhere (in-trace Evaluate button, the
  // tab-close adapter) keyed to this skill's TypeId; `EntityExecutionPanel`
  // auto-lists by `target_typeid_str`. Memoized on `skill` so the array
  // identity is stable across editor keystrokes (else MarkdownEditor's tab/
  // panel memos rebuild every render).
  // Keyed on the STABLE skillKey/editorRef only (never the `skill` object) so a
  // metadata refetch handing back a new `skill` ref does NOT rebuild this array
  // and remount the panels — that remount would wipe UsagePanel's scanned state.
  // The panel reads the live skill via `skillRef`, snapshotted at first build.
  const extraSideTabs = useMemo<ExtraSideTab[] | undefined>(() => {
    if (!skillKey || !skillRef.current) return undefined;
    return [
      {
        id: 'usage',
        label: 'Usage',
        icon: History,
        description: 'Sessions that used this skill — analyze, improve, commit',
        panel: <UsagePanel skill={skillRef.current} skillFile={editorRef} />,
      },
      {
        id: 'eval',
        label: 'Eval',
        icon: FlaskConical,
        description: 'Skill evaluations',
        panel: (
          <EntityExecutionPanel
            target={skillKey}
            processType={ProcessKind.Execution}
            headerLabel="Skill eval"
            className="min-h-0 flex-1"
          />
        ),
      },
    ];
    // Depend on the stable skillKey ONLY (not editorRef/skill) — the host can
    // hand a fresh fsRef each render, and including it here would rebuild the tab
    // array and remount the panels on every render. skillRef/editorRef are
    // snapshotted at first build; both are stable for a given SKILL.md.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillKey]);

  return (
    <MarkdownEditor
      fsRef={editorRef}
      chatTarget={skillKey}
      headerExtras={headerExtras}
      extraSideTabs={extraSideTabs}
      onDelete={skillKey ? onDelete : undefined}
      deleteLabel={skill?.name ?? undefined}
      reloadKey={reloadKey}
    />
  );
}
