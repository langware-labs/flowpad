/**
 * Hub `notification_rule` -- the caller's email rules. A rule key is one dot path, kind then
 * (optionally) one entity: `notification.email.issue.budget_exhausted.deployment.id.<uuid>`.
 * The longest key that prefixes an email's key decides whether it is sent.
 *
 * Every call is a hub-owned `ActionInfo` (forwarded verbatim by the local server), so the
 * desktop and the hub read the same rows.
 */
import { dataManager } from '../APIEntity';
import { hubAction } from './hub-action';

const TYPE = 'notification_rule';

export interface NotificationRule {
  id: string;
  rule_key: string;
  muted: boolean;
}

/** One level of a key's hierarchy, broad -> narrow, as the hub names it. */
export interface NotificationLevel {
  key: string;
  name: string;
  muted: boolean;
}

/** What mute/unmute answer: the key, and its row (null when an unmute removed it). */
export interface NotificationChange {
  key: string;
  rule: NotificationRule | null;
}

export interface NotificationResolve {
  rule: NotificationRule | null;
  ancestors: NotificationLevel[];
}

function keyed(name: string, key: string) {
  const info = hubAction(name, TYPE, null, 'POST');
  info.bodyParameters = { key };
  return info;
}

export class NotificationRulesService {
  async list(): Promise<NotificationRule[]> {
    const rows = await dataManager.callAction<undefined, NotificationRule[]>(hubAction('', TYPE, null, 'GET'));
    return rows ?? [];
  }

  resolve(key: string): Promise<NotificationResolve> {
    return dataManager.callAction<undefined, NotificationResolve>(keyed('resolve', key));
  }

  mute(key: string): Promise<NotificationChange> {
    return dataManager.callAction<undefined, NotificationChange>(keyed('mute', key));
  }

  unmute(key: string): Promise<NotificationChange> {
    return dataManager.callAction<undefined, NotificationChange>(keyed('unmute', key));
  }
}

export const notificationRulesService = new NotificationRulesService();
