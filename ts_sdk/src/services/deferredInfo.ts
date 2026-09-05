import { dataManager } from '../APIEntity';
import { dataContext } from '../FlowSync';
import { capabilityManager } from '../capabilities';
import type { BootstrapInfo } from '../models/BootstrapInfo';
import { snifferManager } from './snifferManager';

/** Runs after SDK readiness. Its failures and entity watches never gate the UI. */
export async function loadDeferredInfo(bootstrap: BootstrapInfo): Promise<void> {
  const snifferRevision = snifferManager.revision;
  try {
    if (bootstrap.info_available === true) {
      const info = await dataManager.info();
      dataContext.applyInfo(info);
      capabilityManager.seedSummary(info.capabilities_summary);
      await snifferManager.seed(info, snifferRevision);
    } else {
      // Older servers report discovery in bootstrap; preserve their disabled default.
      await snifferManager.seed({
        sniffer_hook: bootstrap.sniffer_hook,
        sniffer_installed: bootstrap.sniffer_installed ?? false,
      }, snifferRevision);
    }
  } catch (error) {
    console.warn('[info] Optional runtime information unavailable', error);
  }
}
