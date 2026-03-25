import { dataManager } from '../APIEntity';
import { dataContext } from '../FlowSync';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import type { HooksSnifferStatus } from './hooksSnifferService';

const HOOKS_SNIFFER_ACTION = 'hooks-sniffer';

class SnifferManager {
  async fetchStatus(): Promise<void> {
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    dataContext.setSnifferEnabled(status.enabled);
  }

  async enable(): Promise<HooksSnifferStatus> {
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'POST' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    dataContext.setSnifferEnabled(status.enabled);
    return status;
  }

  async disable(): Promise<HooksSnifferStatus> {
    const action = new ActionInfo(HOOKS_SNIFFER_ACTION, null, null, 'DELETE' as HttpMethod);
    const response = await dataManager.callAction<undefined, HooksSnifferStatus>(action);
    const status = response || { enabled: false };
    dataContext.setSnifferEnabled(status.enabled);
    return status;
  }
}

export const snifferManager = new SnifferManager();
