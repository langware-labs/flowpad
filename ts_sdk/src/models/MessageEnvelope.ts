/**
 * The header a cached message arrived with — mirrors `MessageEnvelope` and
 * `UserProfile` (flow_sdk/builtin/flow_message.py, flow_sdk/sources/values/items.py).
 * Written by the inbox projection; the UI renders it and derives nothing.
 */
import { ICloudOrigin } from './CloudOrigin';

export interface IUserProfile {
  origin: ICloudOrigin;
  name?: string | null;
  address?: string | null;
  avatar_url?: string | null;
}

export interface IMessageEnvelope {
  subject?: string | null;
  sender?: IUserProfile | null;
  recipients?: IUserProfile[];
  sent_at?: string | null;
}

/** `Name <address>` when both are known and differ; whichever one exists otherwise. */
export function profileLabel(profile: IUserProfile | null | undefined): string {
  if (!profile) return '';
  const address = profile.address || profile.origin?.key || '';
  const name = profile.name || '';
  return name && address && name !== address ? `${name} <${address}>` : name || address;
}
