import { t } from '@lingui/core/macro';
import { useCallback, useMemo, useState } from 'react';
import {
  ActionInfo,
  dataManager,
  isProcessRunning,
  ProcessKind,
  type APIEntity,
  type Translation,
} from '@sdk';
// Not re-exported from the '@sdk' barrel (index.ts exports the FSRef class only).
import type { FSRefJson } from '@sdk/fs/FSRef';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { runSkillWorker } from '@src/components/assets/editor/skill/skill-eval-analysis';
import { useProject } from '@src/hooks/useProject';
import { notify } from '@src/notifications';

const TRANSLATOR_SKILL_NAME = 'translator';

/** A translation entry enriched with its live, process-derived status. */
export interface TranslationView {
  lang: string;
  /** FSRef to the translated file — the editor swaps its body to this. */
  ref: FSRefJson;
  processId?: string | null;
  /** `translating` while the launching worker is live; otherwise `ready`. */
  status: 'translating' | 'ready';
}

interface AddTranslationResult {
  lang: string;
  ref: FSRefJson;
  process_id: string | null;
  created: boolean;
}

interface UseTranslationsArgs {
  /** The resolved backing entity (a Markdown-family asset). */
  entity: APIEntity<any> | null;
  /** VFS path the translator process is keyed to (the asset TypeId string). */
  chatTarget: string | null;
  /** On-disk path of the source (original) doc — used in the translator prompt. */
  assetRef: string | null | undefined;
}

interface UseTranslationsResult {
  /** Existing translations with live status, in stored order. */
  translations: TranslationView[];
  /** The language currently shown (`?lang=`), or null for the original doc. */
  activeLang: string | null;
  /** The active translation's FSRef, or null when showing the original. */
  activeRef: FSRefJson | null;
  /** Status of the active translation, or null when showing the original. */
  activeStatus: 'translating' | 'ready' | null;
  /** Whether a launch is in flight (for button disabling). */
  isAdding: boolean;
  /** Navigate to a translation (or back to the original with null). Same tab. */
  openTranslation: (lang: string | null) => void;
  /**
   * Create a translation for `lang` and launch the translator worker:
   *   1. `add_translation` action → placeholder file + entry (returns its ref)
   *   2. navigate to the (empty) pending doc immediately
   *   3. spawn the headless translator worker keyed to the asset
   *   4. `add_translation` again to record the worker's process_id
   * The backend owns every persisted write; this only sequences actions.
   */
  addTranslation: (lang: string) => Promise<void>;
}

/**
 * Owns the document-translation flow for the markdown editor: lists existing
 * translations with process-derived status, launches new ones, and drives the
 * URL-first `?lang=` navigation. Status is DERIVED from the launching worker
 * (via `useProcessesForTarget`), never stored — a translation is "ready" the
 * moment its worker leaves a running state, which the editor uses to bump its
 * reload key and re-read the now-filled file.
 */
export function useTranslations({ entity, chatTarget, assetRef }: UseTranslationsArgs): UseTranslationsResult {
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useProject();
  const [isAdding, setIsAdding] = useState(false);

  // Raw `?lang=` from the URL. It's only *effective* if THIS doc actually has a
  // translation for it — otherwise it's a leftover from another doc (the wiki
  // modal keeps the query param across pages), so we ignore it and show the
  // original rather than mislabelling the switcher / swapping to a missing body.
  const rawLang = currentDock?.lang ?? null;
  const stored = (entity as { translations?: Translation[] } | null)?.translations ?? [];

  // Only poll live processes when there's a worker to derive status from — a
  // doc with no translations (the common case) does no background work.
  const hasTrackedProcess = stored.some((t) => t.process_id);
  const { processes } = useProcessesForTarget(chatTarget ?? '', {
    enabled: !!chatTarget && hasTrackedProcess,
    processType: ProcessKind.Execution,
  });

  const runningByProcessId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of processes) map.set(p.id, isProcessRunning(p.status));
    return map;
  }, [processes]);

  const translations = useMemo<TranslationView[]>(
    () =>
      stored.map((t) => ({
        lang: t.lang,
        ref: t.ref,
        processId: t.process_id,
        status: t.process_id && runningByProcessId.get(t.process_id) ? 'translating' : 'ready',
      })),
    [stored, runningByProcessId],
  );

  const activeView = useMemo(
    () => (rawLang ? (translations.find((t) => t.lang === rawLang) ?? null) : null),
    [translations, rawLang],
  );
  // Effective active language: the found translation's lang (=== rawLang), or
  // null when this doc has no translation for the URL's ?lang=.
  const activeLang = activeView?.lang ?? null;
  const activeRef = activeView?.ref ?? null;
  const activeStatus = activeView?.status ?? null;

  const openTranslation = useCallback(
    (lang: string | null) => {
      if (!currentDock) return;
      navigation.openDock(currentDock.withLang(lang));
    },
    [navigation, currentDock],
  );

  const addTranslation = useCallback(
    async (lang: string) => {
      const typeId = entity?.typeId;
      if (!typeId || !chatTarget) {
        notify.error({ title: t`Cannot translate`, message: t`This file has no backing entity yet.` });
        return;
      }
      setIsAdding(true);
      try {
        // 1. Create the placeholder + entry; get the exact output ref back.
        const create = new ActionInfo('add_translation', typeId.type, typeId.id, 'POST');
        create.bodyParameters = { lang };
        const created = await dataManager.callAction<{ lang: string }, AddTranslationResult>(create);

        // 2. Open the (empty) pending doc immediately — same tab.
        openTranslation(lang);

        // 3. Launch the headless translator worker (shared create→attach→prompt
        //    triad — same one skill-eval/session-analysis use, incl. worker naming).
        const prompt = `translate ${assetRef ?? ''} to language ${lang} and save it to ${created.ref.path} using the translator skill`;
        const proc = await runSkillWorker(
          TRANSLATOR_SKILL_NAME,
          {
            workdir: project?.fs_storage_mount_path ?? undefined,
            projectId: project?.id,
            targetVfsPath: chatTarget,
            processType: ProcessKind.Execution,
            outputFormat: 'stream-json',
            permissionMode: 'bypassPermissions',
          },
          prompt,
          'Translator skill missing',
          `Translate → ${lang}`,
        );

        // 4. Record the worker's process_id so status/auto-refresh survive reload.
        if (proc) {
          const attach = new ActionInfo('add_translation', typeId.type, typeId.id, 'POST');
          attach.bodyParameters = { lang, process_id: proc.id };
          await dataManager.callAction(attach);
        }
      } catch (err) {
        console.error('[translations] addTranslation failed', err);
        notify.error({ title: t`Failed to start translation` });
      } finally {
        setIsAdding(false);
      }
    },
    [entity, chatTarget, assetRef, project, openTranslation],
  );

  return { translations, activeLang, activeRef, activeStatus, isAdding, openTranslation, addTranslation };
}
