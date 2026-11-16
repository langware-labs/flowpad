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
    const enable = !(source.isActive || source.needsSetup);
    setBusy(true);
    try {
      // The backend owns where a resumed source lands: back where it stood, re-checked by its
      // driver — never a fresh start, which would send a verified source through setup again.
      await source.setEnabled(enable);
      source.markEdit();
      // One that came back still owing its setup says so on its own row; "Resumed" would be untrue.
      if (!enable) notify.success({ title: t`Paused.` });
      else if (source.isActive) notify.success({ title: t`Resumed — it polls on the next tick.` });
    } catch (error) {
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
