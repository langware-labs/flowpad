import { t } from '@lingui/core/macro';
import { useMemo, type ReactNode } from 'react';
import { FSRef, type APIEntity } from '@sdk';
import { Languages } from 'lucide-react';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { useTranslationTargets } from '@src/hooks/use-translation-targets';
import { useTranslations } from './useTranslations';
import { TranslationsPanel } from './TranslationsPanel';
import { DocLanguageSwitcher } from './DocLanguageSwitcher';

interface UseDocTranslationsArgs {
  /** The resolved backing entity (a Markdown-family asset), or null. */
  entity: APIEntity<any> | null;
  /** VFS path the translator process is keyed to (the asset TypeId string). */
  chatTarget: string | null;
  /** On-disk path of the source (original) doc — used in the translator prompt. */
  assetRef: string | null | undefined;
  /** The editor ref for the ORIGINAL doc — returned unchanged unless `?lang=`. */
  baseEditorRef: FSRef;
  /** The reload key for the original doc (entity updated_date). */
  baseReloadKey?: string | number;
}

interface UseDocTranslationsResult {
  /** `baseEditorRef`, or the active translation's ref when `?lang=` is set. */
  editorRef: FSRef;
  /** `baseReloadKey`, bumped with lang+status so a finished translation re-reads. */
  reloadKey: string | number | undefined;
  /** The Translations side tab to feed `MarkdownEditor.extraSideTabs`. */
  translationsTab: ExtraSideTab;
  /** Inline language switcher (generic `DocLanguageSwitcher`) for header/plain surfaces. */
  languageSwitcher: ReactNode;
}

/**
 * The reusable document-translation wiring for any markdown editor surface: the
 * inline `?lang=` body swap, the completion auto-refresh, and the Translations
 * side tab. Both `PlainMarkdownAssetEditor` (asset editor) and `WikiResolveView`
 * (the wikitip modal) use it, so a doc can be translated + read inline anywhere
 * it renders — the tab and swap live in one place, not per-surface.
 */
export function useDocTranslations({
  entity,
  chatTarget,
  assetRef,
  baseEditorRef,
  baseReloadKey,
}: UseDocTranslationsArgs): UseDocTranslationsResult {
  const targets = useTranslationTargets();
  const { translations, activeLang, activeRef, activeStatus, isAdding, openTranslation, addTranslation } =
    useTranslations({ entity, chatTarget, assetRef });

  // When `?lang=` is active, the body is the translation file instead of the
  // source `asset_ref`. `activeRef` points at the stored FSRef object, which is
  // stable across status polls, so the editor re-downloads only when the
  // language actually changes — not on every poll.
  const editorRef = useMemo(() => (activeRef ? FSRef.fromJson(activeRef) : baseEditorRef), [activeRef, baseEditorRef]);

  // Auto-refresh a translation the moment its worker finishes: folding the
  // process-derived status into the key re-reads the now-filled file
  // (translating → ready flips the key exactly once).
  const reloadKey = activeLang ? `${baseReloadKey ?? ''}:${activeLang}:${activeStatus ?? ''}` : baseReloadKey;

  // Each surface renders only ONE of these (the side tab OR the inline switcher),
  // so memoize both on their shared inputs — the unused one costs nothing beyond
  // a stable reference, and the used one doesn't re-identity on unrelated renders.
  const translationsTab = useMemo<ExtraSideTab>(
    () => ({
      id: 'translations',
      label: translations.length > 0 ? `Translations ${translations.length}` : 'Translations',
      icon: Languages,
      description: t`Translated copies of this doc`,
      availableInNonAdvanced: true,
      panel: (
        <TranslationsPanel
          translations={translations}
          activeLang={activeLang}
          isAdding={isAdding}
          targets={targets}
          onOpen={openTranslation}
          onAdd={addTranslation}
        />
      ),
    }),
    [translations, activeLang, isAdding, targets, openTranslation, addTranslation],
  );

  const languageSwitcher = useMemo(
    () => (
      <DocLanguageSwitcher
        translations={translations}
        activeLang={activeLang}
        isAdding={isAdding}
        targets={targets}
        onOpen={openTranslation}
        onAdd={addTranslation}
      />
    ),
    [translations, activeLang, isAdding, targets, openTranslation, addTranslation],
  );

  return { editorRef, reloadKey, translationsTab, languageSwitcher };
}
