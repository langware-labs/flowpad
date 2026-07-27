import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';

export interface HooksSnifferStatus {
  enabled: boolean;
  hook_id?: string | null;
  hook_scope?: string | null;
  /** Sniffer commands are present in the harness settings file — it is really running. */
  installed?: boolean;
}

const HOOKS_SNIFFER_ACTION = 'hooks-sniffer';

let _snifferStatusInFlight: Promise<HooksSnifferStatus> | null = null;

export async function getHooksSnifferStatus(): Promise<HooksSnifferStatus> {
  // Deduplicate concurrent calls — multiple components mount simultaneously
  if (_snifferStatusInFlight) return _snifferStatusInFlight;
  _snifferStatusInFlight = (async () => {
    try {
      const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'GET' as HttpMethod);
      const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
      return response || { enabled: false };
    } finally {
      _snifferStatusInFlight = null;
    }
  })();
  return _snifferStatusInFlight;
}

export async function enableHooksSniffer(): Promise<HooksSnifferStatus> {
  const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'POST' as HttpMethod);
  const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
  return response || { enabled: false };
}

export async function disableHooksSniffer(): Promise<HooksSnifferStatus> {
  const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'DELETE' as HttpMethod);
  const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
  return response || { enabled: false };
}
