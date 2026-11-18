/**
 * Live updates of the error-reporting config. A sandbox emits the `sentry_info.changed` tag whenever the
 * value the hub vouches for changes (set, replaced or cleared; an expiry is NOT announced, it takes
 * effect on the next bootstrap); the tag reaches this page over the bridge, and this mirrors it into
 * `dataContext.bootstrapInfo.sentry_info`, which is the one place the UI reads it from.
 * Started from `asyncSdkInit`.
 */

import { dataContext } from '../FlowSync/context';
import type { SentryInfo } from '../models/BootstrapInfo';
import { EventBus } from '../tags/EventBus';

/** The tag `flow_sdk/instance_settings/sentry_info.py` emits (`SENTRY_INFO_CHANGED`). */
export const SENTRY_INFO_CHANGED = 'sentry_info.changed';

class SentryInfoListener {
  private _subscriptions: Promise<void> | null = null;

  startSubscriptions(): Promise<void> {
    return (this._subscriptions ??= this._startSubscriptions());
  }

  private async _startSubscriptions(): Promise<void> {
    const { startTagBridge } = await import('../tags/ws-bridge');
    startTagBridge();
    EventBus.on(SENTRY_INFO_CHANGED, (event) => {
      dataContext.applySentryInfo((event.data as { sentry_info?: SentryInfo | null } | undefined)?.sentry_info ?? null);
    });
  }
}

export const sentryInfoListener = new SentryInfoListener();
