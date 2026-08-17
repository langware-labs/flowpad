import { dataManager } from '../../APIEntity';
import { ActionInfo } from '../../models/ActionInfo';

/**
 * Human half of `flow connect` device-code enrollment (hub typeless action
 * `machine-enroll/{lookup,approve,deny}`). The user code rides in the POST
 * body, never a query string, and every call is hub-reflected: enrollments are
 * hub-owned rows, the desktop merely relays the human's decision.
 */
export interface MachineEnrollmentView {
  hostname: string;
  os_type: string;
  flow_version: string;
  machine_id_short: string;
  client_ip: string;
  requested_at: string;
  expires_at: string;
  expires_in: number;
  suggested_name: string;
}

export interface MachineApproval {
  node_id: string;
  node_typeid: string;
  node_name: string;
}

async function callEnroll<T>(op: 'lookup' | 'approve' | 'deny', body: Record<string, unknown>): Promise<T> {
  const info = new ActionInfo('machine-enroll', null, null, 'POST');
  info.subpath = op;
  info.hubReflect = true; // enrollments live on the hub
  info.bodyParameters = body;
  return await dataManager.callAction<Record<string, unknown>, T>(info);
}

/** `WDJB-MJHT` (any case, with or without the dash) → the machine waiting on it. 404 → throws. */
export function lookupMachineCode(userCode: string): Promise<MachineEnrollmentView> {
  return callEnroll<MachineEnrollmentView>('lookup', { user_code: userCode });
}

/** Approve: the hub creates (or reuses) the caller's `user_machine` node and the machine gets its key. */
export function approveMachine(userCode: string, nodeName?: string): Promise<MachineApproval> {
  return callEnroll<MachineApproval>('approve', { user_code: userCode, node_name: nodeName ?? '' });
}

export function denyMachine(userCode: string): Promise<{ denied: boolean }> {
  return callEnroll<{ denied: boolean }>('deny', { user_code: userCode });
}

/** Display form of a code the user typed: uppercase, `XXXX-XXXX`. */
export function formatMachineCode(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
