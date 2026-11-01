import { useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FSRef, WebApp } from '@sdk';
import type { DocumentValue } from '@sdk/fs/AssetDocument';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { invalidateGitPreflight } from '@src/hooks/use-git-share-preflight';
import { entityReloadKey } from '@src/utils/entity-reload-key';

export type ManifestPatch = Record<string, DocumentValue | undefined>;

/**
 * An app's `webapp.json`, field by field — THE save path for it (the app editor and the app's info panel):
 * a revision-checked document patch, queued so two quick edits never race. `undefined` drops a field.
 * `mainRef` when the caller has it; else it is read from the app's record.
 */
export function useWebAppManifest(app: WebApp, mainRef?: FSRef | null, onSaved?: (patch: ManifestPatch) => void) {
  const { data: record } = useQuery({
    queryKey: ['asset-record-refs', 'local', app.typeId.toString()],
    queryFn: () => app.record(),
    enabled: mainRef === undefined,
  });
  const content = useMarkdownContent(mainRef ?? record?.mainRef ?? null, {
    autoSave: false,
    reloadKey: entityReloadKey(app.updated_date),
  });
  const latest = useRef({ app, content, onSaved });
  latest.current = { app, content, onSaved };
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));

  const save = useCallback((patch: ManifestPatch): Promise<boolean> => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) latest.current.content.dropField(key);
      else latest.current.content.setField(key, value);
    }
    const operation = queue.current.then(async () => {
      const saved = await latest.current.content.save();
      if (saved) {
        latest.current.app.markEdit();
        invalidateGitPreflight(latest.current.app.typeId);
        latest.current.onSaved?.(patch);
      }
      return saved;
    });
    queue.current = operation;
    return operation;
  }, []);

  return { content, save };
}
