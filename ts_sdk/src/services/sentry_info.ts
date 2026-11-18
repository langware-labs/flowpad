/**
 * Live updates of the error-reporting config. A sandbox broadcasts `sentry_info_msg` whenever the
 * value the hub vouches for changes (set, replaced or cleared; an expiry is NOT broadcast, it takes
 * effect on the next bootstrap); this mirrors it into
 * `dataContext.bootstrapInfo.sentry_info`, which is the one place the UI reads it from.
 * Mirrors `privacy_mode.ts`'s `startSubscriptions`; started from `asyncSdkInit`.
 */

import { dataContext } from '../FlowSync/context';
import type { SentryInfoMessage } from '../websocket';

class SentryInfoListener {
  private _subscriptions: Promise<void> | null = null;

  startSubscriptions(): Promise<void> {
    return (this._subscriptions ??= this._startSubscriptions());
  }

  private async _startSubscriptions(): Promise<void> {
    const { ConnectionManager } = await import('../websocket');
    ConnectionManager.getInstance().on('on_sentry_info_msg', (msg: SentryInfoMessage) => {
      dataContext.applySentryInfo(msg.sentry_info ?? null);
    });
  }
}

export const sentryInfoListener = new SentryInfoListener();
