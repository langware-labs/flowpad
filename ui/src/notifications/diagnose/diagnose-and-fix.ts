import { askForHelp, dataContext } from '@sdk';
import { connectionManager } from '@sdk/websocket';
import { t } from '@lingui/core/macro';
import { useDiagnosisLinks } from '../alerts-store';
import { notify } from '../notify';

/** What is being diagnosed — drives the request's wording. */
export type DiagnoseKind = 'error' | 'warning';

/**
 * "Diagnose & fix" — one click, no window, no navigation. The error becomes a PRIVATE help request (nobody
 * asked, ``purpose: repair``) on the Diagnosis channel; the repair runs in the background and lands in that
 * conversation as a diagnosis message, whose arrival raises the standard new-message notification. The
 * warnings-list entry it started from (``entryKey``) shows the diagnosis status meanwhile.
 */
export async function diagnoseAndFix(detail: string, kind: DiagnoseKind = 'error', entryKey?: string): Promise<void> {
  const first = detail.split('\n')[0]?.trim() || (kind === 'warning' ? t`A warning` : t`An error`);
  try {
    const result = await askForHelp({
      // The error itself is the request; that the person asked for a fix is ``purpose: repair``.
      text: detail,
      title: first.slice(0, 80),
      recipients: [],
      purpose: 'repair',
      origin: 'warning',
      project_id: dataContext.project?.id ?? null,
      connection_id: connectionManager.id,
    });
    if (entryKey) useDiagnosisLinks.getState().link(entryKey, result.conversation_id);
  } catch (e: unknown) {
    notify.error({
      title: t`Could not start the diagnosis`,
      message: e instanceof Error ? e.message : String(e),
      forceToast: true,
    });
  }
}
