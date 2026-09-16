/**
 * Re-run ONE source's setup check — the "verify" verb, shared by the sources
 * screen and the attached-channels bar so both report the same way.
 *
 * Idempotent, so it is safe to press after every attempt: pair the phone,
 * invite the bot, press, repeat for whatever is still listed.
 */
import { useCallback, useState } from 'react';
import type { DataDriver } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

export function useSourceVerify(source: DataDriver) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async () => {
    setBusy(true);
    try {
      const result = await source.verify();
      if (result.ready) {
        notify.success({ title: source.name || source.provider, message: result.detail });
      } else {
        // Not an error — nothing failed, the user simply has one more step. A
        // red toast here would send them looking for a broken thing.
        notify.info({ title: t`Not ready yet`, message: result.detail });
      }
    } catch (error) {
      notify.error({
        title: t`Could not verify ${source.name || source.provider}`,
        message: errorMessage(error, t`The check did not run.`),
      });
    } finally {
      setBusy(false);
    }
  }, [source, t]);

  return { verify, busy };
}
