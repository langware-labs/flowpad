import { dataManager } from '../APIEntity';
import { dataContext } from '../FlowSync';
import { capabilityManager } from '../capabilities';
import type { DeferredInfo } from '../models/BootstrapInfo';
import { snifferManager } from './snifferManager';
import type { LoadContext } from '../lazy/definition';

/** Registry loader. Entity watches have their own lifecycle and never gate this read. */
export async function fetchDeferredInfo(context: LoadContext): Promise<DeferredInfo> {
  const bootstrap = dataContext.bootstrapInfo!;
  const revision = snifferManager.revision;
  const info: DeferredInfo = bootstrap.info_available === true ? await dataManager.info() : {
    sniffer_hook: bootstrap.sniffer_hook,
    sniffer_installed: bootstrap.sniffer_installed ?? false,
  };
  if (!context.isCurrent()) throw new Error('SDK scope changed');
  dataContext.applyInfo(info);
  capabilityManager.seedSummary(info.capabilities_summary);
  void snifferManager.seed(info, revision).catch(error => console.warn('[info] Sniffer watch unavailable', error));
  return info;
}
