import { askForHelp, dataContext } from '@sdk';
import { connectionManager } from '@sdk/websocket';
import { t } from '@lingui/core/macro';
import { DockPointer } from '@src/navigation/DockPointer';
import { useAlertStore } from '../alerts-store';
import { navigateTo } from '../commands';
import { notify } from '../notify';

/** What is being diagnosed — drives the request's wording. */
export type DiagnoseKind = 'error' | 'warning';

/** Diagnosed conversations started from a warnings-list entry: a repair is marked on that entry. */
const diagnosedAlerts = new Map<string, string>();

/**
 * "Diagnose & fix" — one click, no window. The error becomes a PRIVATE help request (nobody asked,
 * ``purpose: repair``): its conversation opens at once, the repair runs in the background and lands there
 * as a diagnosis message, which offers Report it when someone else owns the fix.
 */
export async function diagnoseAndFix(detail: string, kind: DiagnoseKind = 'error', alertId?: string): Promise<void> {
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
    if (alertId) diagnosedAlerts.set(result.conversation_id, alertId);
    navigateTo(DockPointer.forConversation(result.conversation_id).toUrl());
  } catch (e: unknown) {
    notify.error({
      title: t`Could not start the diagnosis`,
      message: e instanceof Error ? e.message : String(e),
      forceToast: true,
    });
  }
}

/** The diagnosis repaired the cause: mark the warnings-list entry it was started from as fixed. */
export function markDiagnosedAlert(conversationId: string, summary: string): void {
  const alertId = diagnosedAlerts.get(conversationId);
  if (!alertId) return;
  diagnosedAlerts.delete(conversationId);
  useAlertStore.getState().markFixed(alertId, summary);
}
