/**
 * Pause / resume ONE source — the "listening on/off" verb, shared by the card,
 * its menu and the attached-channels bar so every surface moves the row the
 * same way.
 */
import { useCallback, useState } from 'react';
import type { DataSource } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

export function useSourceToggle(source: DataSource) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    const previous = source.status;
    // Un-pausing returns it to `new` rather than `active`: the backend decides
    // whether this driver still owes a setup step, and a source paused mid-setup
    // must not skip it.
    const next = source.isActive || source.needsSetup ? 'disabled' : 'new';
    setBusy(true);
    try {
      source.status = next;
      const saved = await source.save();
      // The backend resolves `new` to `setup` or `active` on the way in; adopt its
      // verdict, or the row reads as un-parked until the next fetch.
      source.status = saved?.status ?? source.status;
      source.setup_detail = saved?.setup_detail ?? source.setup_detail;
      source.markEdit();
      notify.success({
        title: next === 'disabled' ? t`Paused.` : t`Resumed — it polls on the next tick.`,
      });
    } catch (error) {
      source.status = previous; // the save failed, so the row never moved
      notify.error({
        title: t`Could not update ${source.name || source.provider}`,
        message: errorMessage(error, t`The change was not saved.`),
      });
    } finally {
      setBusy(false);
    }
  }, [source, t]);

  return { toggle, busy };
}
