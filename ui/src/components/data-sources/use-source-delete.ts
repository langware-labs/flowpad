/**
 * Delete ONE source — the verb and its confirm copy, shared by the Data
 * Sources screen and the inbox's channel lists so the cascade sentence
 * ("its streams and every record it ingested") exists once.
 */
import { useCallback, useState } from 'react';
import type { DataSource } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

export function useSourceDelete(onDeleted?: (source: DataSource) => void) {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState<DataSource | null>(null);
  const remove = useCallback(
    async (source: DataSource) => {
      try {
        // `delete()`, not `destroy()` — the TS entity has no destroy, and the
        // backend cascade hangs off `delete_by_id`, which is what this reaches.
        await source.delete();
        onDeleted?.(source);
      } catch (error) {
        notify.error({
          title: t`Could not delete ${source.name || source.provider}`,
          message: errorMessage(error, t`The source was not removed.`),
        });
      }
    },
    [onDeleted, t],
  );
  // Say what else goes: nothing cascades by default, so the backend's delete
  // override is the only reason these disappear together.
  const confirm = {
    title: t`Delete this data source?`,
    description: t`"${deleting?.name || deleting?.provider || ''}" will be removed along with its streams and every record it ingested. This cannot be undone.`,
    confirmLabel: t`Delete`,
  };
  return { deleting, setDeleting, remove, confirm };
}
