/**
 * Re-run ONE source's setup check — the "verify" verb, shared by the sources
 * screen and the attached-channels bar so both report the same way.
 *
 * Idempotent, so it is safe to press after every attempt: pair the phone,
 * invite the bot, press, repeat for whatever is still listed.
 *
 * The outcome is kept as `last` as well as toasted, so a surface that shows it
 * in place (the inbox's attention strip) can pass `{ quiet: true }` and skip the
 * toast — one result, one channel. `verify` never throws: a failed call is an
 * outcome too.
 */
import { useCallback, useState } from 'react';
import type { DataSource, VerifyResult } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

/** What one press answered: the backend's verdict, or why the check did not run. */
export type VerifyOutcome = { result: VerifyResult; error?: undefined } | { result?: undefined; error: string };

export function useSourceVerify(source: DataSource, { quiet = false }: { quiet?: boolean } = {}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<VerifyOutcome | null>(null);

  const verify = useCallback(async () => {
    setBusy(true);
    try {
      const result = await source.verify();
      setLast({ result });
      if (quiet) return;
      // Not ready is not an error — nothing failed, the user simply has one more
      // step. A red toast would send them looking for a broken thing.
      if (result.ready) notify.success({ title: source.name || source.provider, message: result.detail });
      else notify.info({ title: t`Not ready yet`, message: result.detail });
    } catch (error) {
      const message = errorMessage(error, t`The check did not run.`);
      setLast({ error: message });
      if (!quiet) notify.error({ title: t`Could not verify ${source.name || source.provider}`, message });
    } finally {
      setBusy(false);
    }
  }, [source, quiet, t]);

  return { verify, busy, last };
}
